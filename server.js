'use strict';

require('dotenv').config();

// ── Env validation ─────────────────────────────────────────────────────────────

['BASE_URL', 'HOST_PASSWORD', 'SESSION_SECRET'].forEach(key => {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
});

const http      = require('http');
const path      = require('path');
const crypto    = require('crypto');
const express   = require('express');
const { Server } = require('socket.io');
const session   = require('express-session');
const qrcode    = require('qrcode');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const fs        = require('fs');
const multer    = require('multer');

// Ensure data directory exists before opening SQLite
const DATA_PATH = process.env.DATA_PATH || '/data';
fs.mkdirSync(DATA_PATH, { recursive: true });
fs.mkdirSync(path.join(DATA_PATH, 'audio'), { recursive: true });

const db          = require('./src/db');
const gameManager = require('./src/gameManager');
const { t: _t }   = require('./src/i18n-server');
// Helper: read current language from DB and call t()
const t = (key, vars = {}) => _t(key, vars, db.getSetting('ui_language') || 'en');
const {
  registerHandlers,
  revealWithDelay,
  emitLeaderboard,
  startNextQuestion,
  clearAutoTimers,
} = require('./src/socketHandlers');

const app = express();

// ── Core middleware ────────────────────────────────────────────────────────────

// Only trust the proxy on Railway (production); on localhost this causes HTTPS upgrade issues
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────

app.use(helmet({
  // Only enable CSP in production — in dev it blocks Tailwind CDN and inline scripts
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc:         ["'self'", 'data:', 'https:', 'http:'],
      connectSrc:     ["'self'", 'wss:', 'ws:', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
    },
  } : false,
  crossOriginEmbedderPolicy: false, // Socket.io needs this off
  hsts: process.env.NODE_ENV === 'production',
}));

// ── Login rate limiter ─────────────────────────────────────────────────────────

// ── Login rate limiter (reads max_login_attempts from DB on each request) ────────────

const _loginAttempts = new Map(); // ip → { count, windowStart }
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function loginLimiter(req, res, next) {
  const maxAttempts = parseInt(db.getSetting('max_login_attempts') ?? '20', 10) || 20;
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = _loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    _loginAttempts.set(ip, { count: 1, windowStart: now });
    return next();
  }
  entry.count++;
  if (entry.count > maxAttempts) {
    return res.status(429).json({ error: t('err.ratelimit') });
  }
  next();
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 14_400_000, // 4 hours
  },
});

app.use(sessionMiddleware);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Static files ──────────────────────────────────────────────────────────────
// Prevent browsers from storing stale copies — forces a fresh fetch every time.
const staticOpts = { etag: true, lastModified: true, setHeaders: (res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
}};
app.use('/host',       express.static(path.join(__dirname, 'public/host'), staticOpts));
app.use('/display',    express.static(path.join(__dirname, 'public/display'), staticOpts));
app.use('/play',       express.static(path.join(__dirname, 'public/play'), staticOpts));
app.use('/shared.css', express.static(path.join(__dirname, 'public/shared.css'), staticOpts));
app.use('/audio.js',   express.static(path.join(__dirname, 'public/audio.js'), staticOpts));
app.use('/audio',      express.static(path.join(__dirname, 'public/audio'), staticOpts));
app.use('/uploads/audio', express.static(path.join(DATA_PATH, 'audio'), staticOpts));
app.use('/i18n.js',    express.static(path.join(__dirname, 'public/i18n.js'), staticOpts));
app.use('/lang.js',    express.static(path.join(__dirname, 'public/lang.js'), staticOpts));

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireHost(req, res, next) {
  if (req.session.isHost) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ error: t('err.unauthorized') });
  }
  return res.redirect('/host/login');
}

// ── CSRF protection ───────────────────────────────────────────────────────────
// State-changing host API routes require X-CSRF-Token header matching the
// session token. Login/logout/GET requests are exempt.

function requireCsrf(req, res, next) {
  // Only enforce on state-changing methods for API routes
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // Unauthenticated requests are handled by requireHost (→ 401); CSRF only applies to live sessions
  if (!req.session?.isHost) return next();
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: t('err.csrf') });
  }
  return next();
}

// Validate image URL: must be http:// or https:// or null/empty
function validateImageUrl(url) {
  if (!url || (typeof url === 'string' && !url.trim())) return null;
  const trimmed = String(url).trim();
  if (!/^https?:\/\//i.test(trimmed)) return 'imageUrl must start with http:// or https://';
  return null; // null means valid
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.redirect('/host/login'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Host auth ─────────────────────────────────────────────────────────────────

function getEffectivePassword() {
  return db.getSetting('host_password') ?? process.env.HOST_PASSWORD;
}

app.get('/host/login', (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/host/login.html'));
});

app.post('/host/login', loginLimiter, (req, res) => {
  const expected = Buffer.from(getEffectivePassword());
  const provided  = Buffer.from(String(req.body.password ?? ''));
  // Constant-time comparison via padding to equal length
  const len = Math.max(expected.length, provided.length);
  const a   = Buffer.alloc(len);
  expected.copy(a);
  const b   = Buffer.alloc(len);
  provided.copy(b);

  if (crypto.timingSafeEqual(a, b)) {
    req.session.isHost = true;
    // Generate CSRF token on successful login
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    // Dynamic session timeout from settings
    const sessionHours = parseFloat(db.getSetting('session_timeout_hours') ?? '4') || 4;
    const sessionMaxAge = Math.round(sessionHours * 3600 * 1000);
    req.session.cookie.maxAge = sessionMaxAge;
    // Clear failed login counter for this IP
    _loginAttempts.delete(req.ip || req.socket?.remoteAddress);
    req.session.save(() => {
      // Set CSRF cookie readable by JS (not httpOnly) so client can include it in headers
      res.cookie('csrf-token', req.session.csrfToken, {
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: sessionMaxAge,
      });
      res.redirect('/host/');
    });
    return;
  }
  return res.redirect('/host/login?error=1');
}); 

app.post('/host/logout', (req, res) => {
  res.clearCookie('csrf-token');
  req.session.destroy(() => res.redirect('/host/login'));
});

// Apply CSRF check to all state-changing host API routes
app.use('/host/api', requireCsrf);

app.post('/host/api/settings/password', requireHost, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: t('err.pw.fields_required') });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: t('err.pw.mismatch') });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: t('err.pw.too_short') });
  }
  const effective = getEffectivePassword();
  const expBuf = Buffer.alloc(Math.max(effective.length, currentPassword.length));
  Buffer.from(effective).copy(expBuf);
  const prvBuf = Buffer.alloc(expBuf.length);
  Buffer.from(currentPassword).copy(prvBuf);
  if (!crypto.timingSafeEqual(expBuf, prvBuf)) {
    return res.status(400).json({ error: t('err.pw.incorrect') });
  }
  db.setSetting('host_password', newPassword);
  return res.json({ ok: true });
});

// ── General settings GET/PUT ──────────────────────────────────────────────────

// Validation rules per setting key: { type, min?, max?, pattern? }
const SETTING_RULES = {
  platform_name:                { type: 'string',  minLen: 1, maxLen: 60 },
  logo_url:                     { type: 'url_or_empty' },
  accent_color:                 { type: 'color' },
  default_time_limit:           { type: 'int',     min: 5,   max: 120 },
  max_players:                  { type: 'int',     min: 2,   max: 100 },
  streak_bonus_3:               { type: 'int',     min: 0,   max: 500 },
  streak_bonus_5:               { type: 'int',     min: 0,   max: 500 },
  allow_late_joins:             { type: 'bool' },
  require_nickname_confirm:     { type: 'bool' },
  profanity_filter:             { type: 'bool' },
  auto_advance_seconds:         { type: 'int',     min: 0,   max: 300 },
  reveal_delay_seconds:         { type: 'int',     min: 0,   max: 30  },
  leaderboard_duration_seconds: { type: 'int',     min: 0,   max: 60  },
  show_answer_counts:           { type: 'bool' },
  show_player_count:            { type: 'bool' },
  session_timeout_hours:        { type: 'int',     min: 1,   max: 24  },
  max_login_attempts:           { type: 'int',     min: 3,   max: 100 },
  // ── Audio ────────────────────────────────────────────────────────────────
  sound_enabled:                { type: 'bool' },
  sfx_volume:                   { type: 'int',     min: 0,   max: 100 },
  music_volume:                 { type: 'int',     min: 0,   max: 100 },
  sfx_pack:                     { type: 'enum',    values: ['classic','modern','punchy','off'] },
  bgm_lobby:                    { type: 'bgm_track', builtIn: ['lobby-chill','lobby-upbeat','off'] },
  bgm_question:                  { type: 'bgm_track', builtIn: ['question-action','question-electronic','off'] },
  // ── Gameplay shuffle ────────────────────────────────────────────────
  shuffle_questions:             { type: 'bool' },
  shuffle_options:               { type: 'bool' },
  // ── Display ────────────────────────────────────────────────────────────────
  display_mode:                  { type: 'enum',    values: ['standard','widescreen'] },
  // ── Language ────────────────────────────────────────────────────────────────
  ui_language:                  { type: 'enum',    values: ['en','es'] },
};

function validateSettingValue(key, value) {
  const rule = SETTING_RULES[key];
  if (!rule) return t('err.settings.unknown', { key });
  if (rule.type === 'enum') {
    if (!rule.values.includes(value)) return t('err.settings.enum', { key, values: rule.values.join(', ') });
  } else if (rule.type === 'bool') {
    if (value !== 'true' && value !== 'false') return t('err.settings.bool', { key });
  } else if (rule.type === 'int') {
    const n = parseInt(value, 10);
    if (isNaN(n)) return t('err.settings.not_int', { key });
    if (n < rule.min || n > rule.max) return t('err.settings.range', { key, min: rule.min, max: rule.max });
  } else if (rule.type === 'string') {
    const s = String(value ?? '');
    if (s.length < rule.minLen || s.length > rule.maxLen) return t('err.settings.str_len', { key, min: rule.minLen, max: rule.maxLen });
  } else if (rule.type === 'color') {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(value))) return t('err.settings.color', { key });
  } else if (rule.type === 'url_or_empty') {
    const s = String(value ?? '').trim();
    if (s && !/^https?:\/\//i.test(s)) return t('err.settings.url', { key });
  } else if (rule.type === 'bgm_track') {
    if (rule.builtIn.includes(value)) return null;
    if (/^custom:[\w.-]+$/.test(value)) {
      const filename = value.slice(7);
      if (!db.getCustomAudioByFilename(filename)) return `Unknown custom audio: ${filename}`;
      return null;
    }
    return t('err.settings.enum', { key, values: rule.builtIn.join(', ') + ', custom:...' });
  }
  return null; // valid
}

app.get('/host/api/settings', requireHost, (_req, res) => {
  return res.json(db.getAllSettings());
});

app.put('/host/api/settings', requireHost, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: t('err.settings.not_object') });
  const errors = {};
  const clean = {};
  for (const [key, value] of Object.entries(updates)) {
    const err = validateSettingValue(key, String(value ?? ''));
    if (err) errors[key] = err;
    else clean[key] = String(value ?? '');
  }
  if (Object.keys(errors).length) return res.status(400).json({ errors });
  db.setSettings(clean);

  // Push setting changes to connected clients in real-time
  const LIVE_KEYS = ['ui_language','display_mode','bgm_lobby','bgm_question',
    'sound_enabled','sfx_volume','music_volume','sfx_pack'];
  const payload = {};
  for (const k of LIVE_KEYS) { if (clean[k] !== undefined) payload[k] = clean[k]; }
  if (Object.keys(payload).length) {
    const ioRef = req.app.get('io');
    const state = gameManager.getState();
    if (ioRef && state) {
      ioRef.to(`session:${state.pin}`).emit('settings-updated', payload);
    }
  }

  return res.json({ ok: true, saved: Object.keys(clean) });
});

// ── Custom Audio Upload API ───────────────────────────────────────────────────
const audioUpload = multer({
  dest: path.join(DATA_PATH, 'audio'),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'audio/mpeg' || file.originalname.toLowerCase().endsWith('.mp3')) {
      cb(null, true);
    } else {
      cb(new Error('Only .mp3 files are allowed'));
    }
  },
});

app.post('/host/api/audio/upload', requireHost, (req, res, next) => {
  audioUpload.single('audio')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const category = req.body.category;
    if (!['lobby', 'question'].includes(category)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'category must be lobby or question' });
    }
    // Rename to add .mp3 extension
    const filename = req.file.filename + '.mp3';
    const newPath = req.file.path + '.mp3';
    fs.renameSync(req.file.path, newPath);
    const row = db.addCustomAudio(filename, req.file.originalname, category);
    return res.json(row);
  });
});

app.get('/host/api/audio/list', requireHost, (_req, res) => {
  return res.json(db.getAllCustomAudio());
});

app.delete('/host/api/audio/:id', requireHost, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = db.getCustomAudioById(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(DATA_PATH, 'audio', row.filename);
  try { fs.unlinkSync(filePath); } catch {}
  db.deleteCustomAudio(id);
  return res.json({ ok: true });
});

// ── Public branding endpoint (no auth — for display/play screens) ─────────────
app.get('/api/settings/public', (_req, res) => {
  const all = db.getAllSettings();
  return res.json({
    platform_name:            all.platform_name,
    logo_url:                 all.logo_url,
    accent_color:             all.accent_color,
    require_nickname_confirm: all.require_nickname_confirm,
    ui_language:              all.ui_language,
    // Audio settings for the display screen
    sound_enabled:            all.sound_enabled,
    sfx_volume:               all.sfx_volume,
    music_volume:             all.music_volume,
    sfx_pack:                 all.sfx_pack,
    bgm_lobby:                all.bgm_lobby,
    bgm_question:             all.bgm_question,
    display_mode:             all.display_mode,
  });
});

app.get('/host/', requireHost, (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/host/index.html'));
});

// ── Session control REST API ──────────────────────────────────────────────────

app.post('/host/api/session/start', requireHost, async (req, res) => {
  const { quizId } = req.body;
  if (!quizId) return res.status(400).json({ error: t('err.session.quiz_id_required') });

  const quiz = db.getQuizById(Number(quizId));
  if (!quiz) return res.status(404).json({ error: t('err.session.quiz_not_found') });
  if (!quiz.questions.length) {
    return res.status(400).json({ error: t('err.session.no_questions') });
  }

  try {
    const state   = await gameManager.startSession(Number(quizId));
    const baseUrl = process.env.BASE_URL.startsWith('http') ? process.env.BASE_URL : `https://${process.env.BASE_URL}`;
    const playUrl = `${baseUrl}/play?pin=${state.pin}`;
    const qrDataUrl = await qrcode.toDataURL(playUrl, { width: 320 });

    // Store qrDataUrl in the state (ephemeral — not needed in DB)
    state.qrDataUrl = qrDataUrl;

    return res.status(201).json({
      sessionId: state.sessionId,
      pin: state.pin,
      qrDataUrl,
      quizName: quiz.name,
      questionCount: quiz.questions.length,
    });
  } catch (err) {
    console.error('start session error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/host/api/session/next', requireHost, (req, res) => {
  if (!gameManager.hasActiveSession()) {
    return res.status(400).json({ error: t('err.session.no_active') });
  }
  const state = gameManager.getState();

  switch (state.status) {
    case 'lobby':
      clearAutoTimers();
      startNextQuestion(io, state.pin, gameManager);
      break;
    case 'question':
      clearAutoTimers();
      revealWithDelay(io, state.pin, gameManager);
      break;
    case 'reveal':
      clearAutoTimers();
      emitLeaderboard(io, state.pin, gameManager);
      break;
    case 'leaderboard': {
      clearAutoTimers();
      const next = state.currentQuestionIndex + 1;
      if (next >= state.questions.length) {
        const finalLeaderboard = gameManager.endSession();
        io.to(`session:${state.pin}`).emit('game-ended', {
          podium: finalLeaderboard.slice(0, 3),
          allPlayers: finalLeaderboard,
          archived: false,
        });
        return res.json({ status: 'ended' });
      }
      startNextQuestion(io, state.pin, gameManager);
      break;
    }
    default:
      return res.status(400).json({ error: t('err.session.bad_advance', { status: state.status }) });
  }

  return res.json({ status: gameManager.hasActiveSession() ? gameManager.getState().status : 'ended' });
});

app.post('/host/api/session/reveal', requireHost, (req, res) => {
  if (!gameManager.hasActiveSession()) {
    return res.status(400).json({ error: t('err.session.no_active') });
  }
  const state = gameManager.getState();
  if (state.status !== 'question') {
    return res.status(400).json({ error: t('err.session.not_question') });
  }
  clearAutoTimers();
  revealWithDelay(io, state.pin, gameManager);
  return res.json({ status: 'reveal', questionIndex: state.currentQuestionIndex });
});

app.post('/host/api/session/end', requireHost, (req, res) => {
  if (!gameManager.hasActiveSession()) {
    return res.status(400).json({ error: t('err.session.no_active') });
  }
  const state = gameManager.getState();
  const pin = state.pin;
  const finalLeaderboard = gameManager.endSession();
  io.to(`session:${pin}`).emit('game-ended', {
    podium: finalLeaderboard.slice(0, 3),
    allPlayers: finalLeaderboard,
    archived: false,
  });
  return res.json({ status: 'ended' });
});

// ── Public session lookup ─────────────────────────────────────────────────────

app.get('/api/session/:pin', (req, res) => {
  const row = db.getSessionByPin(req.params.pin);
  if (!row || row.status === 'ended') {
    return res.status(404).json({ valid: false, error: t('err.session.not_found') });
  }
  return res.json({ valid: true, status: row.status });
});

// ── Quiz CRUD REST API ────────────────────────────────────────────────────────

app.get('/host/api/quizzes', requireHost, (_req, res) => {
  res.json(db.getAllQuizzes());
});

app.get('/host/api/quizzes/export/all', requireHost, (_req, res) => {
  const quizzes = db.getAllQuizzes();
  const allData = quizzes.map(q => {
    const full = db.getQuizById(q.id);
    return {
      name: full.name,
      questions: (full.questions || []).map(question => ({
        text: question.text,
        options: question.options,
        correctIndex: question.correct_index,
        timeLimitSeconds: question.time_limit_seconds,
        type: question.type || 'mcq',
        imageUrl: question.image_url || null,
        explanation: question.explanation || null,
      })),
    };
  });
  const exportPayload = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    quizzes: allData,
  };
  res.setHeader('Content-Disposition', 'attachment; filename="romeu_quizzes_backup.json"');
  res.setHeader('Content-Type', 'application/json');
  return res.json(exportPayload);
});

app.post('/host/api/quizzes/import', requireHost, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: t('err.quiz.import_invalid') });
  }

  let quizzesToImport = [];
  if (Array.isArray(body)) {
    quizzesToImport = body;
  } else if (Array.isArray(body.quizzes)) {
    quizzesToImport = body.quizzes;
  } else if (body.name && Array.isArray(body.questions)) {
    quizzesToImport = [body];
  } else {
    return res.status(400).json({ error: t('err.quiz.import_invalid') });
  }

  if (quizzesToImport.length === 0) {
    return res.status(400).json({ error: t('err.quiz.import_invalid') });
  }

  const createdQuizzes = [];
  for (const item of quizzesToImport) {
    const name = String(item.name || 'Imported Quiz').trim().slice(0, 100) || 'Imported Quiz';
    const quiz = db.createQuiz(name);
    const questions = Array.isArray(item.questions) ? item.questions : [];
    for (const q of questions) {
      if (!q.text || !String(q.text).trim()) continue;
      const questionType = q.type === 'truefalse' ? 'truefalse' : 'mcq';
      let options = q.options;
      if (typeof options === 'string') {
        try { options = JSON.parse(options); } catch { options = null; }
      }
      if (questionType === 'truefalse') {
        options = ['True', 'False'];
      } else if (!Array.isArray(options) || options.length !== 4) {
        options = (Array.isArray(options) && options.length === 4) ? options : ['Option 1', 'Option 2', 'Option 3', 'Option 4'];
      }
      const rawCI = q.correctIndex !== undefined ? q.correctIndex : q.correct_index;
      const ci = Number.isInteger(Number(rawCI)) ? Number(rawCI) : 0;
      const rawTLS = q.timeLimitSeconds !== undefined ? q.timeLimitSeconds : q.time_limit_seconds;
      const tls = Number.isInteger(Number(rawTLS)) ? Number(rawTLS) : 20;
      const img = typeof q.imageUrl === 'string' ? q.imageUrl.trim() : (typeof q.image_url === 'string' ? q.image_url.trim() : null);
      const expl = typeof q.explanation === 'string' ? q.explanation.trim() : null;

      db.addQuestion(
        quiz.id,
        String(q.text).trim(),
        options,
        Math.max(0, Math.min(questionType === 'truefalse' ? 1 : 3, ci)),
        Math.max(5, Math.min(120, tls)),
        questionType,
        img || null,
        expl || null
      );
    }
    const full = db.getQuizById(quiz.id);
    createdQuizzes.push({ ...full, question_count: full.questions.length });
  }

  return res.status(201).json({
    importedCount: createdQuizzes.length,
    quizzes: createdQuizzes,
  });
});

app.post('/host/api/quizzes', requireHost, (req, res) => {
  const name = (req.body.name ?? '').trim();
  if (!name || name.length > 100) {
    return res.status(400).json({ error: t('err.quiz.name_required') });
  }
  const quiz = db.createQuiz(name);
  return res.status(201).json(quiz);
});

app.get('/host/api/quizzes/:id', requireHost, (req, res) => {
  const quiz = db.getQuizById(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });
  return res.json(quiz);
});

app.get('/host/api/quizzes/:id/export', requireHost, (req, res) => {
  const quiz = db.getQuizById(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });
  const exportData = {
    formatVersion: 1,
    name: quiz.name,
    questions: (quiz.questions || []).map(q => ({
      text: q.text,
      options: q.options,
      correctIndex: q.correct_index,
      timeLimitSeconds: q.time_limit_seconds,
      type: q.type || 'mcq',
      imageUrl: q.image_url || null,
      explanation: q.explanation || null,
    })),
  };
  res.setHeader('Content-Disposition', `attachment; filename="${quiz.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json"`);
  res.setHeader('Content-Type', 'application/json');
  return res.json(exportData);
});

app.put('/host/api/quizzes/:id', requireHost, (req, res) => {
  const id   = Number(req.params.id);
  const name = (req.body.name ?? '').trim();
  if (!name || name.length > 100) {
    return res.status(400).json({ error: t('err.quiz.name_required') });
  }
  const quiz = db.getQuizById(id);
  if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });
  db.updateQuizName(id, name);
  return res.json({ id, name });
});

app.delete('/host/api/quizzes/:id', requireHost, (req, res) => {
  const id = Number(req.params.id);
  const quiz = db.getQuizById(id);
  if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });
  db.deleteQuiz(id);
  return res.status(204).send();
});

app.post('/host/api/quizzes/:id/duplicate', requireHost, (req, res) => {
  const id = Number(req.params.id);
  const quiz = db.getQuizById(id);
  if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });
  const newQuiz = db.createQuiz(`Copy of ${quiz.name}`);
  for (const q of quiz.questions) {
    db.addQuestion(newQuiz.id, q.text, q.options, q.correct_index, q.time_limit_seconds,
      q.type || 'mcq', q.image_url || null, q.explanation || null);
  }
  return res.status(201).json({ ...newQuiz, question_count: quiz.questions.length });
});

app.put('/host/api/quizzes/:id/reorder', requireHost, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = db.getQuizById(quizId);
  if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });
  const { questionIds } = req.body;
  if (!Array.isArray(questionIds)) return res.status(400).json({ error: 'questionIds array required' });
  const existing = new Set(quiz.questions.map(q => q.id));
  if (questionIds.length !== existing.size || !questionIds.every(id => existing.has(id))) {
    return res.status(400).json({ error: 'questionIds must contain all question IDs for this quiz' });
  }
  db.reorderQuestions(quizId, questionIds);
  return res.json({ ok: true });
});

app.get('/host/api/sessions', requireHost, (_req, res) => {
  res.json(db.getCompletedSessions());
});

app.get('/host/api/sessions/:id', requireHost, (req, res) => {
  res.json(db.getSessionAnswerBreakdown(Number(req.params.id)));
});

app.post('/host/api/quizzes/:id/questions', requireHost, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz   = db.getQuizById(quizId);
  if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });

  const { text, options, correctIndex, timeLimitSeconds, type, imageUrl, explanation } = req.body;
  const questionType = type === 'truefalse' ? 'truefalse' : 'mcq';

  if (!text || !text.trim()) {
    return res.status(400).json({ error: t('err.q.text_required') });
  }

  const tls = Number(timeLimitSeconds);
  const ci  = Number(correctIndex);
  let parsedOptions;

  if (questionType === 'truefalse') {
    parsedOptions = ['True', 'False'];
    if (!Number.isInteger(ci) || ci < 0 || ci > 1) {
      return res.status(400).json({ error: t('err.q.tf_correct_index') });
    }
  } else {
    parsedOptions = options;
    if (typeof parsedOptions === 'string') {
      try { parsedOptions = JSON.parse(parsedOptions); } catch { parsedOptions = null; }
    }
    if (!Array.isArray(parsedOptions) || parsedOptions.length !== 4
        || parsedOptions.some(o => typeof o !== 'string' || !o.trim())) {
      return res.status(400).json({ error: t('err.q.mcq_options') });
    }
    if (!Number.isInteger(ci) || ci < 0 || ci > 3) {
      return res.status(400).json({ error: t('err.q.mcq_correct_range') });
    }
  }

  if (!Number.isInteger(tls) || tls < 5 || tls > 120) {
    return res.status(400).json({ error: t('err.q.time_range') });
  }

  const imgUrlRaw = typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : null;
  if (imgUrlRaw) {
    const imgErr = validateImageUrl(imgUrlRaw);
    if (imgErr) return res.status(400).json({ error: imgErr });
  }
  const imgUrl = imgUrlRaw;
  const expl   = typeof explanation === 'string' && explanation.trim() ? explanation.trim() : null;

  const question = db.addQuestion(
    quizId, text.trim(),
    questionType === 'truefalse' ? parsedOptions : parsedOptions.map(o => o.trim()),
    ci, tls, questionType, imgUrl, expl
  );
  question.options = JSON.parse(question.options);
  return res.status(201).json(question);
});

app.put('/host/api/questions/:id', requireHost, (req, res) => {
  const id = Number(req.params.id);

  // Pre-fetch existing question so we can do type-aware validation
  const existing = db.getQuestionById(id);
  if (!existing) return res.status(404).json({ error: t('err.q.not_found') });

  const fields = {};

  if (req.body.text !== undefined) {
    const text = req.body.text.trim();
    if (!text) return res.status(400).json({ error: t('err.q.text_empty') });
    fields.text = text;
  }

  if (req.body.type !== undefined) {
    const t = req.body.type;
    if (t !== 'mcq' && t !== 'truefalse') return res.status(400).json({ error: _t('err.q.bad_type') });
    fields.type = t;
  }

  if (req.body.options !== undefined) {
    let opts = req.body.options;
    if (typeof opts === 'string') {
      try { opts = JSON.parse(opts); } catch { opts = null; }
    }
    if (!Array.isArray(opts) || (opts.length !== 2 && opts.length !== 4) || opts.some(o => typeof o !== 'string' || !o.trim())) {
      return res.status(400).json({ error: t('err.q.options_invalid') });
    }
    fields.options = opts.map(o => o.trim());
  }

  if (req.body.correct_index !== undefined) {
    const ci = Number(req.body.correct_index);
    // Validate against effective type (body override takes priority over DB value)
    const effectiveType = fields.type ?? existing.type ?? 'mcq';
    const maxCI = effectiveType === 'truefalse' ? 1 : 3;
    if (!Number.isInteger(ci) || ci < 0 || ci > maxCI) {
      return res.status(400).json({
        error: effectiveType === 'truefalse'
          ? t('err.q.tf_correct_index')
          : t('err.q.mcq_correct_range'),
      });
    }
    fields.correct_index = ci;
  }

  if (req.body.time_limit_seconds !== undefined) {
    const tls = Number(req.body.time_limit_seconds);
    if (!Number.isInteger(tls) || tls < 5 || tls > 120) {
      return res.status(400).json({ error: t('err.q.time_range') });
    }
    fields.time_limit_seconds = tls;
  }

  if (req.body.image_url !== undefined) {
    const rawUrl = req.body.image_url ? String(req.body.image_url).trim() || null : null;
    if (rawUrl) {
      const imgErr = validateImageUrl(rawUrl);
      if (imgErr) return res.status(400).json({ error: imgErr });
    }
    fields.image_url = rawUrl;
  }

  if (req.body.explanation !== undefined) {
    fields.explanation = req.body.explanation ? String(req.body.explanation).trim() || null : null;
  }

  // If no valid fields were provided, return existing question unchanged
  if (Object.keys(fields).length === 0) {
    if (existing.options && typeof existing.options === 'string') existing.options = JSON.parse(existing.options);
    return res.json(existing);
  }

  const updated = db.updateQuestion(id, fields);
  if (updated.options && typeof updated.options === 'string') {
    updated.options = JSON.parse(updated.options);
  }
  return res.json(updated);
});

app.delete('/host/api/questions/:id', requireHost, (req, res) => {
  const id = Number(req.params.id);
  // Check if exists (deleteQuestion returns RunResult, not the row)
  const result = db.deleteQuestion(id);
  if (result.changes === 0) return res.status(404).json({ error: t('err.q.not_found') });
  return res.status(204).send();
});

// ── HTTP server + Socket.io ───────────────────────────────────────────────────

const server = http.createServer(app);
const io     = new Server(server, { cors: false });

// Share io with modules that need to emit
app.set('io', io);
gameManager._setIo = (ioRef) => { gameManager._io = ioRef; };

registerHandlers(io, db, gameManager, sessionMiddleware);

// ── Crash recovery ────────────────────────────────────────────────────────────

const interrupted = db.getInterruptedSession();
if (interrupted) {
  const resumed = gameManager.restoreFromDb(interrupted);
  if (resumed) {
    console.warn('Resumed interrupted session PIN', interrupted.pin, 'at question', interrupted.current_question_index);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log('Listening on port', PORT));

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);
  // Persist active game state so it can be recovered on restart
  const state = gameManager.getState();
  if (state) {
    try {
      db.saveSessionStateJson(
        state.sessionId,
        JSON.stringify(state),
        state.status,
        state.currentQuestionIndex
      );
      console.log('Active session state persisted to DB');
    } catch (err) {
      console.error('Failed to persist session state:', err.message);
    }
  }
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  // Force-exit after 5s if connections won't drain
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Global error guards ─────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message, err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// ── Internal helpers ──────────────────────────────────────────────────────────

function _buildQuestionStartPayload(state) {
  const q = state.questions[state.currentQuestionIndex];
  return {
    questionIndex: state.currentQuestionIndex,
    totalQuestions: state.questions.length,
    text: q.text,
    options: q.options,
    timeLimitSeconds: q.time_limit_seconds,
    type: q.type || 'mcq',
    imageUrl: q.image_url || null,
    questionOpenAt: state.questionOpenAt,
    players: Array.from(state.players.values()).filter(p => p.connected).map(p => p.nickname),
  };
}
