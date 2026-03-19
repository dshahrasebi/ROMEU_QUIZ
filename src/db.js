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
`);

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

const addQuestion = (quizId, text, options, correctIndex, timeLimitSeconds) => {
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM questions WHERE quiz_id = ?'
  ).get(quizId).m;
  return db.prepare(`
    INSERT INTO questions (quiz_id, text, options, correct_index, time_limit_seconds, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(quizId, text, JSON.stringify(options), correctIndex, timeLimitSeconds, maxOrder + 1);
};

const updateQuestion = (id, fields) => {
  const allowed = ['text', 'options', 'correct_index', 'time_limit_seconds'];
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

module.exports = {
  // quiz
  createQuiz:    (name) => createQuiz.get(name),
  getAllQuizzes:  () => getAllQuizzes.all(),
  getQuizById,
  updateQuizName: (id, name) => updateQuizName.run(name, id),
  deleteQuiz:    (id) => deleteQuiz.run(id),
  // question
  addQuestion,
  updateQuestion,
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
};
