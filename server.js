'use strict';

require('dotenv').config();

// ── Env validation ─────────────────────────────────────────────────────────────

['BASE_URL', 'HOST_PASSWORD', 'SESSION_SECRET'].forEach(key => {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
});

const http    = require('http');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const session = require('express-session');
const qrcode  = require('qrcode');

const db          = require('./src/db');
const gameManager = require('./src/gameManager');
const { registerHandlers } = require('./src/socketHandlers');

const app = express();

// ── Core middleware ────────────────────────────────────────────────────────────

app.set('trust proxy', 1); // Required for Railway TLS termination

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

app.use('/host',       express.static(path.join(__dirname, 'public/host')));
app.use('/display',    express.static(path.join(__dirname, 'public/display')));
app.use('/play',       express.static(path.join(__dirname, 'public/play')));
app.use('/shared.css', express.static(path.join(__dirname, 'public/shared.css')));

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireHost(req, res, next) {
  if (req.session.isHost) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/host/login');
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Host auth ─────────────────────────────────────────────────────────────────

app.get('/host/login', (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/host/login.html'));
});

app.post('/host/login', (req, res) => {
  const expected = Buffer.from(process.env.HOST_PASSWORD);
  const provided  = Buffer.from(String(req.body.password ?? ''));
  // Constant-time comparison via padding to equal length
  const len = Math.max(expected.length, provided.length);
  const a   = Buffer.alloc(len);
  expected.copy(a);
  const b   = Buffer.alloc(len);
  provided.copy(b);

  if (crypto.timingSafeEqual(a, b)) {
    req.session.isHost = true;
    return res.redirect('/host/');
  }
  return res.redirect('/host/login?error=1');
});

app.post('/host/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/host/login'));
});

app.get('/host/', requireHost, (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/host/index.html'));
});

// ── Session control REST API ──────────────────────────────────────────────────

app.post('/host/api/session/start', requireHost, async (req, res) => {
  const { quizId } = req.body;
  if (!quizId) return res.status(400).json({ error: 'quizId is required' });

  const quiz = db.getQuizById(Number(quizId));
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (!quiz.questions.length) {
    return res.status(400).json({ error: 'Quiz must have at least one question' });
  }

  try {
    const state   = await gameManager.startSession(Number(quizId));
    const playUrl = `${process.env.BASE_URL}/play?pin=${state.pin}`;
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
    return res.status(400).json({ error: 'No active session' });
  }
  const state = gameManager.getState();
  let result;

  switch (state.status) {
    case 'lobby':
      result = gameManager.nextQuestion();
      io.to(`session:${state.pin}`).emit('question-start', _buildQuestionStartPayload(state));
      break;
    case 'question':
      result = gameManager.revealAnswer();
      io.to(`session:${state.pin}`).emit('question-reveal', result);
      break;
    case 'reveal': {
      const leaderboard = gameManager.showLeaderboard();
      result = { status: 'leaderboard', leaderboard };
      io.to(`session:${state.pin}`).emit('leaderboard-update', { leaderboard });
      break;
    }
    case 'leaderboard': {
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
      result = gameManager.nextQuestion();
      io.to(`session:${state.pin}`).emit('question-start', _buildQuestionStartPayload(state));
      break;
    }
    default:
      return res.status(400).json({ error: `Cannot advance from status: ${state.status}` });
  }

  return res.json({ status: gameManager.hasActiveSession() ? gameManager.getState().status : 'ended' });
});

app.post('/host/api/session/reveal', requireHost, (req, res) => {
  if (!gameManager.hasActiveSession()) {
    return res.status(400).json({ error: 'No active session' });
  }
  const state = gameManager.getState();
  if (state.status !== 'question') {
    return res.status(400).json({ error: 'Not in question phase' });
  }
  const payload = gameManager.revealAnswer();
  io.to(`session:${state.pin}`).emit('question-reveal', payload);
  return res.json({ status: 'reveal', questionIndex: state.currentQuestionIndex });
});

app.post('/host/api/session/end', requireHost, (req, res) => {
  if (!gameManager.hasActiveSession()) {
    return res.status(400).json({ error: 'No active session' });
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
    return res.status(404).json({ valid: false, error: 'Session not found or has ended' });
  }
  return res.json({ valid: true, status: row.status });
});

// ── Quiz CRUD REST API ────────────────────────────────────────────────────────

app.get('/host/api/quizzes', requireHost, (_req, res) => {
  res.json(db.getAllQuizzes());
});

app.post('/host/api/quizzes', requireHost, (req, res) => {
  const name = (req.body.name ?? '').trim();
  if (!name || name.length > 100) {
    return res.status(400).json({ error: 'name is required (1–100 characters)' });
  }
  const quiz = db.createQuiz(name);
  return res.status(201).json(quiz);
});

app.get('/host/api/quizzes/:id', requireHost, (req, res) => {
  const quiz = db.getQuizById(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  return res.json(quiz);
});

app.put('/host/api/quizzes/:id', requireHost, (req, res) => {
  const id   = Number(req.params.id);
  const name = (req.body.name ?? '').trim();
  if (!name || name.length > 100) {
    return res.status(400).json({ error: 'name is required (1–100 characters)' });
  }
  const quiz = db.getQuizById(id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  db.updateQuizName(id, name);
  return res.json({ id, name });
});

app.delete('/host/api/quizzes/:id', requireHost, (req, res) => {
  const id = Number(req.params.id);
  const quiz = db.getQuizById(id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  db.deleteQuiz(id);
  return res.status(204).send();
});

app.post('/host/api/quizzes/:id/questions', requireHost, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz   = db.getQuizById(quizId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

  const { text, options, correctIndex, timeLimitSeconds } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  let parsedOptions = options;
  if (typeof parsedOptions === 'string') {
    try { parsedOptions = JSON.parse(parsedOptions); } catch { parsedOptions = null; }
  }
  if (!Array.isArray(parsedOptions) || parsedOptions.length !== 4
      || parsedOptions.some(o => typeof o !== 'string' || !o.trim())) {
    return res.status(400).json({ error: 'options must be an array of exactly 4 non-empty strings' });
  }

  const ci  = Number(correctIndex);
  const tls = Number(timeLimitSeconds);
  if (!Number.isInteger(ci) || ci < 0 || ci > 3) {
    return res.status(400).json({ error: 'correctIndex must be 0–3' });
  }
  if (!Number.isInteger(tls) || tls < 5 || tls > 120) {
    return res.status(400).json({ error: 'timeLimitSeconds must be 5–120' });
  }

  const question = db.addQuestion(quizId, text.trim(), parsedOptions.map(o => o.trim()), ci, tls);
  question.options = JSON.parse(question.options);
  return res.status(201).json(question);
});

app.put('/host/api/questions/:id', requireHost, (req, res) => {
  const id = Number(req.params.id);
  const fields = {};

  if (req.body.text !== undefined) {
    const text = req.body.text.trim();
    if (!text) return res.status(400).json({ error: 'text must not be empty' });
    fields.text = text;
  }

  if (req.body.options !== undefined) {
    let opts = req.body.options;
    if (typeof opts === 'string') {
      try { opts = JSON.parse(opts); } catch { opts = null; }
    }
    if (!Array.isArray(opts) || opts.length !== 4 || opts.some(o => typeof o !== 'string' || !o.trim())) {
      return res.status(400).json({ error: 'options must be an array of exactly 4 non-empty strings' });
    }
    fields.options = opts.map(o => o.trim());
  }

  if (req.body.correct_index !== undefined) {
    const ci = Number(req.body.correct_index);
    if (!Number.isInteger(ci) || ci < 0 || ci > 3) {
      return res.status(400).json({ error: 'correctIndex must be 0–3' });
    }
    fields.correct_index = ci;
  }

  if (req.body.time_limit_seconds !== undefined) {
    const tls = Number(req.body.time_limit_seconds);
    if (!Number.isInteger(tls) || tls < 5 || tls > 120) {
      return res.status(400).json({ error: 'timeLimitSeconds must be 5–120' });
    }
    fields.time_limit_seconds = tls;
  }

  const updated = db.updateQuestion(id, fields);
  if (!updated) return res.status(404).json({ error: 'Question not found' });
  if (updated.options && typeof updated.options === 'string') {
    updated.options = JSON.parse(updated.options);
  }
  return res.json(updated);
});

app.delete('/host/api/questions/:id', requireHost, (req, res) => {
  const id = Number(req.params.id);
  // Check if exists (deleteQuestion returns RunResult, not the row)
  const result = db.deleteQuestion(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Question not found' });
  return res.status(204).send();
});

// ── HTTP server + Socket.io ───────────────────────────────────────────────────

const server = http.createServer(app);
const io     = new Server(server, { transports: ['websocket'], cors: false });

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

// ── Internal helpers ──────────────────────────────────────────────────────────

function _buildQuestionStartPayload(state) {
  const q = state.questions[state.currentQuestionIndex];
  return {
    questionIndex: state.currentQuestionIndex,
    totalQuestions: state.questions.length,
    text: q.text,
    options: q.options,
    timeLimitSeconds: q.time_limit_seconds,
    questionOpenAt: state.questionOpenAt,
  };
}
