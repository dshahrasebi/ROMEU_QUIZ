'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DATA_PATH = process.env.DATA_PATH ?? '/data';
const DB_PATH = path.join(DATA_PATH, 'quiz.db');

const db = new Database(DB_PATH);

// Enable WAL mode and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS quizzes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id            INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    text               TEXT    NOT NULL,
    options            TEXT    NOT NULL, -- JSON array of 4 strings
    correct_index      INTEGER NOT NULL CHECK(correct_index BETWEEN 0 AND 3),
    time_limit_seconds INTEGER NOT NULL DEFAULT 20 CHECK(time_limit_seconds BETWEEN 5 AND 120),
    sort_order         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    pin                   TEXT    NOT NULL UNIQUE,
    quiz_id               INTEGER NOT NULL REFERENCES quizzes(id),
    status                TEXT    NOT NULL DEFAULT 'lobby',
    current_question_index INTEGER NOT NULL DEFAULT -1,
    state_json            TEXT,
    started_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    ended_at              TEXT
  );

  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    nickname   TEXT    NOT NULL,
    socket_id  TEXT,
    score      INTEGER NOT NULL DEFAULT 0,
    connected  INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS answer_submissions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    option_index INTEGER NOT NULL,
    elapsed_ms   INTEGER NOT NULL,
    points_earned INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, player_id, question_id)
  );

  CREATE INDEX IF NOT EXISTS idx_questions_quiz      ON questions(quiz_id);
  CREATE INDEX IF NOT EXISTS idx_players_session     ON players(session_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_session_question ON answer_submissions(session_id, question_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── Schema migrations (idempotent) ───────────────────────────────────────────────────

for (const sql of [
  `ALTER TABLE questions ADD COLUMN type        TEXT NOT NULL DEFAULT 'mcq'`,
  `ALTER TABLE questions ADD COLUMN image_url   TEXT`,
  `ALTER TABLE questions ADD COLUMN explanation TEXT`,
]) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

// ── Quiz helpers ──────────────────────────────────────────────────────────────

const createQuiz = db.prepare(`
  INSERT INTO quizzes (name) VALUES (?) RETURNING *
`);

const getAllQuizzes = db.prepare(`
  SELECT q.*, (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS question_count
  FROM quizzes q
  ORDER BY q.created_at DESC
`);

const getQuizById = (id) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id);
  if (!quiz) return null;
  const questions = db.prepare(
    'SELECT * FROM questions WHERE quiz_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(id);
  questions.forEach(q => { q.options = JSON.parse(q.options); });
  return { ...quiz, questions };
};

const updateQuizName = db.prepare('UPDATE quizzes SET name = ? WHERE id = ?');
const deleteQuiz     = db.prepare('DELETE FROM quizzes WHERE id = ?');

// ── Question helpers ──────────────────────────────────────────────────────────

const getQuestionById = db.prepare('SELECT * FROM questions WHERE id = ?');

const addQuestion = (quizId, text, options, correctIndex, timeLimitSeconds, type = 'mcq', imageUrl = null, explanation = null) => {
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM questions WHERE quiz_id = ?'
  ).get(quizId).m;
  return db.prepare(`
    INSERT INTO questions (quiz_id, text, options, correct_index, time_limit_seconds, sort_order, type, image_url, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(quizId, text, JSON.stringify(options), correctIndex, timeLimitSeconds, maxOrder + 1, type, imageUrl, explanation);
};

const updateQuestion = (id, fields) => {
  const allowed = ['text', 'options', 'correct_index', 'time_limit_seconds', 'type', 'image_url', 'explanation'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      sets.push(`${k} = ?`);
      vals.push(k === 'options' ? JSON.stringify(v) : v);
    }
  }
  if (!sets.length) return null;
  vals.push(id);
  return db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...vals);
};

const deleteQuestion = db.prepare('DELETE FROM questions WHERE id = ?');

// ── Session helpers ───────────────────────────────────────────────────────────

const createSession = db.prepare(`
  INSERT INTO sessions (pin, quiz_id) VALUES (?, ?) RETURNING *
`);

const getSessionByPin = db.prepare('SELECT * FROM sessions WHERE pin = ?');

const updateSessionStatus = db.prepare(`
  UPDATE sessions SET status = ?, current_question_index = ? WHERE id = ?
`);

const saveSessionStateJson = db.prepare(`
  UPDATE sessions SET state_json = ?, status = ?, current_question_index = ? WHERE id = ?
`);

const getInterruptedSession = db.prepare(`
  SELECT * FROM sessions
  WHERE status NOT IN ('ended')
  ORDER BY started_at DESC
  LIMIT 1
`);

const markSessionEnded = db.prepare(`
  UPDATE sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?
`);

// ── Player helpers ────────────────────────────────────────────────────────────

const createPlayer = db.prepare(`
  INSERT INTO players (session_id, nickname, socket_id) VALUES (?, ?, ?) RETURNING *
`);

const getPlayersBySession = db.prepare('SELECT * FROM players WHERE session_id = ?');

const updatePlayerScore = db.prepare('UPDATE players SET score = ? WHERE id = ?');

const setPlayerConnected = db.prepare('UPDATE players SET connected = ? WHERE id = ?');

const updatePlayerSocketId = db.prepare('UPDATE players SET socket_id = ? WHERE id = ?');

// ── Submission helpers ────────────────────────────────────────────────────────

const createAnswerSubmission = db.prepare(`
  INSERT OR IGNORE INTO answer_submissions
    (session_id, player_id, question_id, option_index, elapsed_ms, points_earned)
  VALUES (?, ?, ?, ?, ?, ?)
  RETURNING *
`);

// ── Analytics helpers ────────────────────────────────────────────────────────────────

const getCompletedSessions = () =>
  db.prepare(`
    SELECT s.id, s.pin, s.status, s.started_at, s.ended_at, q.name AS quiz_name,
      (SELECT COUNT(*) FROM players WHERE session_id = s.id) AS player_count,
      (SELECT nickname FROM players WHERE session_id = s.id ORDER BY score DESC LIMIT 1) AS winner_nickname,
      (SELECT MAX(score) FROM players WHERE session_id = s.id) AS winner_score
    FROM sessions s
    JOIN quizzes q ON q.id = s.quiz_id
    WHERE s.status = 'ended'
    ORDER BY s.started_at DESC
    LIMIT 50
  `).all();

const getSessionAnswerBreakdown = (sessionId) => {
  const questions = db.prepare(`
    SELECT q.id, q.text, q.options, q.correct_index, q.sort_order
    FROM questions q
    JOIN sessions s ON s.quiz_id = q.quiz_id
    WHERE s.id = ?
    ORDER BY q.sort_order ASC, q.id ASC
  `).all(sessionId);
  const submissions = db.prepare(`
    SELECT question_id, option_index, COUNT(*) AS count
    FROM answer_submissions
    WHERE session_id = ?
    GROUP BY question_id, option_index
  `).all(sessionId);
  return questions.map(q => {
    const opts = JSON.parse(q.options);
    const tally = Array(opts.length).fill(0);
    for (const s of submissions) {
      if (s.question_id === q.id && s.option_index >= 0 && s.option_index < tally.length)
        tally[s.option_index] = s.count;
    }
    return { id: q.id, text: q.text, options: opts, correctIndex: q.correct_index, tally, total: tally.reduce((a, b) => a + b, 0) };
  });
};

// ── Settings helpers ──────────────────────────────────────────────────────────

const SETTING_DEFAULTS = {
  platform_name:                'ROMEU Quiz',
  logo_url:                     '',
  accent_color:                 '#7c3aed',
  default_time_limit:           '20',
  max_players:                  '30',
  streak_bonus_3:               '100',
  streak_bonus_5:               '200',
  allow_late_joins:             'false',
  require_nickname_confirm:     'false',
  profanity_filter:             'false',
  auto_advance_seconds:         '0',
  reveal_delay_seconds:         '0',
  leaderboard_duration_seconds: '0',
  show_answer_counts:           'true',
  show_player_count:            'true',
  session_timeout_hours:        '4',
  max_login_attempts:           '20',
  // ── Language ─────────────────────────────────────────────────────────────
  ui_language:                  'en',
  // ── Audio (display screen only) ────────────────────────────────────────
  sound_enabled:                'true',
  sfx_volume:                   '80',
  music_volume:                 '50',
  sfx_pack:                     'classic',
  bgm_lobby:                    'lobby-chill',
  bgm_question:                 'question-action',
  // ── Gameplay shuffle ────────────────────────────────────────────────
  shuffle_questions:             'false',
  shuffle_options:               'false',
  // ── Display ────────────────────────────────────────────────────────────
  display_mode:                  'standard',
};

const reorderQuestions = (quizId, orderedIds) => {
  const update = db.prepare('UPDATE questions SET sort_order = ? WHERE id = ? AND quiz_id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index, id, quizId));
  })();
};

const getAllSettings = () => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = { ...SETTING_DEFAULTS };
  for (const { key, value } of rows) {
    if (key in result) result[key] = value;
  }
  return result;
};

const _setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

const setSettings = (obj) => {
  const upsert = db.transaction((entries) => {
    for (const [key, value] of entries) {
      _setSettingStmt.run(key, String(value));
    }
  });
  upsert(Object.entries(obj));
};

module.exports = {
  SETTING_DEFAULTS,
  // quiz
  createQuiz:    (name) => createQuiz.get(name),
  getAllQuizzes:  () => getAllQuizzes.all(),
  getQuizById,
  updateQuizName: (id, name) => updateQuizName.run(name, id),
  deleteQuiz: (id) => {
    // sessions.quiz_id has no ON DELETE CASCADE, so manually remove sessions first
    // (players and answer_submissions cascade from sessions)
    db.prepare('DELETE FROM sessions WHERE quiz_id = ?').run(id);
    return deleteQuiz.run(id);
  },
  // question
  addQuestion,
  updateQuestion,
  reorderQuestions,
  getQuestionById: (id) => getQuestionById.get(id),
  deleteQuestion: (id) => deleteQuestion.run(id),
  // session
  createSession:        (pin, quizId) => createSession.get(pin, quizId),
  getSessionByPin:      (pin) => getSessionByPin.get(pin),
  updateSessionStatus:  (id, status, idx) => updateSessionStatus.run(status, idx, id),
  saveSessionStateJson: (id, stateJson, status, idx) => saveSessionStateJson.run(stateJson, status, idx, id),
  getInterruptedSession: () => getInterruptedSession.get(),
  markSessionEnded:     (id) => markSessionEnded.run(id),
  // player
  createPlayer:        (sessionId, nickname, socketId) => createPlayer.get(sessionId, nickname, socketId),
  getPlayersBySession: (sessionId) => getPlayersBySession.all(sessionId),
  updatePlayerScore:   (playerId, newScore) => updatePlayerScore.run(newScore, playerId),
  setPlayerConnected:  (playerId, connected) => setPlayerConnected.run(connected ? 1 : 0, playerId),
  updatePlayerSocketId: (playerId, socketId) => updatePlayerSocketId.run(socketId, playerId),
  // submission
  createAnswerSubmission: (sessionId, playerId, questionId, optionIndex, elapsedMs, pointsEarned) =>
    createAnswerSubmission.get(sessionId, playerId, questionId, optionIndex, elapsedMs, pointsEarned),
  // analytics
  getCompletedSessions,
  getSessionAnswerBreakdown,
  // settings
  getSetting: (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  setSetting: (key, value) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  },
  getAllSettings,
  setSettings,
};
