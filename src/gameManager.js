'use strict';

const db = require('./db');
const crypto = require('crypto');

// Scoring formula: 500 + 500 * timeRatio (range 500-1000)
function calcPoints(timeLimitSeconds, elapsedMs) {
  const ratio = Math.max(0, (timeLimitSeconds * 1000 - elapsedMs) / (timeLimitSeconds * 1000));
  return Math.round(500 + 500 * ratio);
}

function generatePin() {
  return (Math.floor(100000 + Math.random() * 900000)).toString();
}

// ── In-memory state ───────────────────────────────────────────────────────────

let state = null;

/**
 * state shape:
 * {
 *   sessionId: number,
 *   pin: string,
 *   quizId: number,
 *   questions: Question[],         // full question objects with options[]
 *   currentQuestionIndex: number,  // -1 = lobby, >= 0 = question shown
 *   status: 'lobby' | 'question' | 'reveal' | 'leaderboard' | 'ended',
 *   players: Map<socketId, { playerId, nickname, score, connected }>,
 *   questionOpenAt: number | null, // Date.now() when question opened
 *   answers: Map<playerId, { optionIndex, elapsedMs, points }>  // current-question answers
 *   timer: NodeJS.Timeout | null
 * }
 */

// ── Public API ────────────────────────────────────────────────────────────────

function hasActiveSession() {
  return state !== null;
}

function getState() {
  return state;
}

function getPublicState() {
  if (!state) return null;
  return {
    pin: state.pin,
    status: state.status,
    currentQuestionIndex: state.currentQuestionIndex,
    totalQuestions: state.questions.length,
    playerCount: state.players.size,
    quizId: state.quizId,
  };
}

async function startSession(quizId) {
  // Archive any previous active session
  const interrupted = db.getInterruptedSession();
  if (interrupted) {
    db.markSessionEnded(interrupted.id);
  }
  if (state && state.timer) clearTimeout(state.timer);

  // Generate unique PIN
  let pin;
  let attempts = 0;
  do {
    pin = generatePin();
    attempts++;
    if (attempts > 20) throw new Error('Could not generate unique PIN');
  } while (db.getSessionByPin(pin));

  const session = db.createSession(pin, quizId);
  const quiz = db.getQuizById(quizId);
  if (!quiz || !quiz.questions.length) {
    throw new Error('Quiz not found or has no questions');
  }

  state = {
    sessionId: session.id,
    pin,
    quizId,
    questions: quiz.questions,
    currentQuestionIndex: -1,
    status: 'lobby',
    players: new Map(),
    questionOpenAt: null,
    answers: new Map(),
    timer: null,
  };

  _persist();
  return state;
}

function addPlayer(socketId, nickname) {
  if (!state) throw new Error('No active session');
  if (state.status !== 'lobby') throw new Error('Game already in progress');
  if (state.players.size >= 30) throw new Error('Session full (max 30 players)');

  // Check for duplicate nickname
  for (const p of state.players.values()) {
    if (p.nickname.toLowerCase() === nickname.toLowerCase()) {
      throw new Error('Nickname already taken');
    }
  }

  const player = db.createPlayer(state.sessionId, nickname, socketId);
  state.players.set(socketId, {
    playerId: player.id,
    nickname,
    score: 0,
    connected: true,
  });
  return player;
}

function reconnectPlayer(socketId, playerId, nickname) {
  if (!state) return false;
  // find by playerId
  for (const [oldSocketId, p] of state.players.entries()) {
    if (p.playerId === playerId && p.nickname === nickname) {
      // update socket mapping
      state.players.delete(oldSocketId);
      p.connected = true;
      state.players.set(socketId, p);
      db.updatePlayerSocketId(playerId, socketId);
      db.setPlayerConnected(playerId, true);
      return true;
    }
  }
  return false;
}

function playerDisconnected(socketId) {
  if (!state) return null;
  const player = state.players.get(socketId);
  if (player) {
    player.connected = false;
    db.setPlayerConnected(player.playerId, false);
  }
  return player || null;
}

function nextQuestion() {
  if (!state) throw new Error('No active session');
  if (state.status !== 'lobby' && state.status !== 'leaderboard') {
    throw new Error(`Cannot advance from status: ${state.status}`);
  }

  const nextIdx = state.currentQuestionIndex + 1;
  if (nextIdx >= state.questions.length) {
    return endSession();
  }

  state.currentQuestionIndex = nextIdx;
  state.status = 'question';
  state.questionOpenAt = Date.now();
  state.answers = new Map();

  _persist();
  return state;
}

function submitAnswer(socketId, optionIndex) {
  if (!state || state.status !== 'question') return null;
  const player = state.players.get(socketId);
  if (!player) return null;
  if (state.answers.has(player.playerId)) return null; // already answered

  const question = state.questions[state.currentQuestionIndex];
  const elapsedMs = Date.now() - state.questionOpenAt;

  const isCorrect = optionIndex === question.correct_index;
  const points = isCorrect ? calcPoints(question.time_limit_seconds, elapsedMs) : 0;

  state.answers.set(player.playerId, { optionIndex, elapsedMs, points, isCorrect });

  db.createAnswerSubmission(
    state.sessionId,
    player.playerId,
    question.id,
    optionIndex,
    elapsedMs,
    points
  );

  if (points > 0) {
    player.score += points;
    db.updatePlayerScore(player.playerId, player.score);
  }

  return { isCorrect, points, totalAnswers: state.answers.size };
}

function revealAnswer() {
  if (!state || state.status !== 'question') throw new Error('Not in question phase');
  state.status = 'reveal';
  _persist();
  return _buildRevealPayload();
}

function showLeaderboard() {
  if (!state || state.status !== 'reveal') throw new Error('Not in reveal phase');
  state.status = 'leaderboard';
  _persist();
  return getLeaderboard();
}

function getLeaderboard() {
  if (!state) return [];
  return Array.from(state.players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((p, i) => ({ rank: i + 1, nickname: p.nickname, score: p.score }));
}

function endSession() {
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.status = 'ended';
  db.markSessionEnded(state.sessionId);
  const leaderboard = getLeaderboard();
  state = null;
  return leaderboard;
}

function getLobbyPlayers() {
  if (!state) return [];
  return Array.from(state.players.values()).map(p => ({
    nickname: p.nickname,
    connected: p.connected,
  }));
}

function getCurrentQuestionForHost() {
  if (!state || state.currentQuestionIndex < 0) return null;
  const q = state.questions[state.currentQuestionIndex];
  return {
    index: state.currentQuestionIndex,
    total: state.questions.length,
    text: q.text,
    options: q.options,
    correctIndex: q.correct_index,
    timeLimitSeconds: q.time_limit_seconds,
    answerCount: state.answers.size,
    playerCount: state.players.size,
  };
}

function getCurrentQuestionForPlayer() {
  if (!state || state.currentQuestionIndex < 0) return null;
  const q = state.questions[state.currentQuestionIndex];
  return {
    index: state.currentQuestionIndex,
    total: state.questions.length,
    text: q.text,
    options: q.options,
    timeLimitSeconds: q.time_limit_seconds,
    questionOpenAt: state.questionOpenAt,
  };
}

// Restore in-memory state after server restart
function restoreFromDb(sessionRow) {
  if (!sessionRow) return false;
  const quiz = db.getQuizById(sessionRow.quiz_id);
  if (!quiz) return false;

  const players = db.getPlayersBySession(sessionRow.id);
  const playerMap = new Map();
  for (const p of players) {
    playerMap.set(p.socket_id || `disconnected_${p.id}`, {
      playerId: p.id,
      nickname: p.nickname,
      score: p.score,
      connected: false, // all disconnected on restart
    });
  }

  state = {
    sessionId: sessionRow.id,
    pin: sessionRow.pin,
    quizId: sessionRow.quiz_id,
    questions: quiz.questions,
    currentQuestionIndex: sessionRow.current_question_index,
    status: sessionRow.status,
    players: playerMap,
    questionOpenAt: null,
    answers: new Map(),
    timer: null,
  };

  // If we crashed mid-question, move to reveal
  if (state.status === 'question') {
    state.status = 'reveal';
    _persist();
  }

  return true;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _persist() {
  if (!state) return;
  const stateJson = JSON.stringify({
    players: Array.from(state.players.entries()),
    answers: Array.from(state.answers.entries()),
    questionOpenAt: state.questionOpenAt,
  });
  db.saveSessionStateJson(state.sessionId, stateJson, state.status, state.currentQuestionIndex);
}

function _buildRevealPayload() {
  const q = state.questions[state.currentQuestionIndex];
  const answerCounts = [0, 0, 0, 0];
  for (const ans of state.answers.values()) {
    if (ans.optionIndex >= 0 && ans.optionIndex <= 3) answerCounts[ans.optionIndex]++;
  }

  // Build per-player results keyed by nickname for the player UI
  const playerResults = {};
  for (const player of state.players.values()) {
    const ans = state.answers.get(player.playerId);
    playerResults[player.nickname] = {
      correct: ans !== undefined && ans.optionIndex === q.correct_index,
      pointsEarned: ans?.points ?? 0,
      newScore: player.score,
    };
  }

  return {
    correctIndex: q.correct_index,
    answerCounts,
    totalAnswers: state.answers.size,
    totalPlayers: state.players.size,
    playerResults,
  };
}

module.exports = {
  hasActiveSession,
  getState,
  getPublicState,
  startSession,
  addPlayer,
  reconnectPlayer,
  playerDisconnected,
  nextQuestion,
  submitAnswer,
  revealAnswer,
  showLeaderboard,
  getLeaderboard,
  endSession,
  getLobbyPlayers,
  getCurrentQuestionForHost,
  getCurrentQuestionForPlayer,
  restoreFromDb,
};
