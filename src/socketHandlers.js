'use strict';

const { isProfane } = require('./profanity');

// ── Module-level auto-advance timers ─────────────────────────────────────────
let _autoAdvanceTimer = null; // reveal → leaderboard
let _leaderboardTimer = null; // leaderboard → next question / end

function _clearAutoTimers() {
  if (_autoAdvanceTimer) { clearTimeout(_autoAdvanceTimer); _autoAdvanceTimer = null; }
  if (_leaderboardTimer)  { clearTimeout(_leaderboardTimer);  _leaderboardTimer = null; }
}

// Locks state to 'reveal' immediately, then emits after optional delay.
// Also schedules auto-advance to leaderboard if configured.
function _revealWithDelay(io, pin, gameManager) {
  const cur = gameManager.getState();
  if (!cur || cur.status !== 'question') return;
  const delaySecs   = cur.settings?.revealDelaySeconds  || 0;
  const advanceSecs = cur.settings?.autoAdvanceSeconds  || 0;
  const payload = gameManager.revealAnswer(); // state → 'reveal'
  if (!payload) return;

  function doEmit() {
    // Attach auto-advance metadata so the host UI can show a countdown
    payload.autoAdvanceSeconds = advanceSecs;
    io.to(`session:${pin}`).emit('question-reveal', payload);
    if (advanceSecs > 0) {
      _autoAdvanceTimer = setTimeout(() => {
        _autoAdvanceTimer = null;
        const s = gameManager.getState();
        if (s && s.status === 'reveal') _emitLeaderboard(io, s.pin, gameManager);
      }, advanceSecs * 1000);
    }
  }

  if (delaySecs > 0) setTimeout(doEmit, delaySecs * 1000);
  else doEmit();
}

// Shows leaderboard and optionally auto-advances after leaderboard duration.
function _emitLeaderboard(io, pin, gameManager) {
  const leaderboard = gameManager.showLeaderboard();
  const s = gameManager.getState();
  const durSecs = s?.settings?.leaderboardDurationSeconds || 0;
  io.to(`session:${pin}`).emit('leaderboard-update', { leaderboard, leaderboardDurationSeconds: durSecs });
  if (durSecs > 0) {
    _leaderboardTimer = setTimeout(() => {
      _leaderboardTimer = null;
      const cur = gameManager.getState();
      if (!cur || cur.status !== 'leaderboard') return;
      if (cur.currentQuestionIndex + 1 >= cur.questions.length) {
        const final = gameManager.endSession();
        io.to(`session:${cur.pin}`).emit('game-ended', {
          podium: final.slice(0, 3), allPlayers: final, archived: false,
        });
      } else {
        _startNextQuestion(io, cur.pin, gameManager);
      }
    }, durSecs * 1000);
  }
}

// Advances to the next question and schedules timer-based auto-reveal.
function _startNextQuestion(io, pin, gameManager) {
  const s = gameManager.nextQuestion();
  const q = s.questions[s.currentQuestionIndex];
  io.to(`session:${pin}`).emit('question-start', {
    questionIndex:  s.currentQuestionIndex,
    totalQuestions: s.questions.length,
    text:           q.text,
    options:        q.options,
    timeLimitSeconds: q.time_limit_seconds,
    type:    q.type || 'mcq',
    imageUrl: q.image_url || null,
    questionOpenAt: s.questionOpenAt,
    players: Array.from(s.players.values()).filter(p => p.connected).map(p => p.nickname),
  });
  gameManager.scheduleAutoReveal(q.time_limit_seconds * 1000, () => {
    const cur = gameManager.getState();
    if (!cur || cur.status !== 'question') return;
    _revealWithDelay(io, cur.pin, gameManager);
  });
}

/**
 * registerHandlers — wires all Socket.io events for host, display, and player.
 * Called once from server.js after io is created.
 */
function registerHandlers(io, db, gameManager, sessionMiddleware) {

  // Bridge express-session onto Socket.io requests so socket.request.session works
  io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
  });

  io.on('connection', (socket) => {

    // ── Host events ──────────────────────────────────────────────────────────

    socket.on('host-join', ({ pin } = {}) => {
      if (!socket.request.session || !socket.request.session.isHost) {
        return socket.emit('error', { message: 'Unauthorized' });
      }

      const state = gameManager.getState();
      if (!state || state.pin !== pin) {
        return socket.emit('error', { message: 'No active session for that PIN' });
      }

      socket.join(`session:${pin}`);
      socket.join(`host:${pin}`);

      socket.emit('host-state', {
        sessionId: state.sessionId,
        pin: state.pin,
        status: state.status,
        currentQuestionIndex: state.currentQuestionIndex,
        questionCount: state.questions.length,
        qrDataUrl: state.qrDataUrl || null,
        players: Array.from(state.players.values()).map(p => ({
          nickname: p.nickname,
          score: p.score,
          connected: p.connected,
        })),
      });
    });

    socket.on('host-next', ({ pin } = {}) => {
      if (!socket.request.session || !socket.request.session.isHost) {
        return socket.emit('error', { message: 'Unauthorized' });
      }
      _handleHostNext(io, pin, gameManager, socket);
    });

    socket.on('host-reveal', ({ pin } = {}) => {
      if (!socket.request.session || !socket.request.session.isHost) {
        return socket.emit('error', { message: 'Unauthorized' });
      }
      const state = gameManager.getState();
      if (!state || state.pin !== pin || state.status !== 'question') {
        return socket.emit('error', { message: 'Cannot reveal now' });
      }
      _clearAutoTimers();
      _revealWithDelay(io, pin, gameManager);
    });

    socket.on('host-end', ({ pin } = {}) => {
      if (!socket.request.session || !socket.request.session.isHost) {
        return socket.emit('error', { message: 'Unauthorized' });
      }
      const state = gameManager.getState();
      if (!state || state.pin !== pin) {
        return socket.emit('error', { message: 'No active session' });
      }
      const finalLeaderboard = gameManager.endSession();
      io.to(`session:${pin}`).emit('game-ended', {
        podium: finalLeaderboard.slice(0, 3),
        allPlayers: finalLeaderboard,
        archived: false,
      });
    });

    // ── Display events ────────────────────────────────────────────────────────

    socket.on('display-join', ({ pin } = {}) => {
      socket.join(`session:${pin}`);
      socket.join(`display:${pin}`);

      const state = gameManager.getState();
      if (!state || state.pin !== pin) {
        return socket.emit('display-state', { status: 'idle' });
      }

      const payload = {
        sessionId: state.sessionId,
        pin: state.pin,
        status: state.status,
        currentQuestionIndex: state.currentQuestionIndex,
        questionCount: state.questions.length,
        qrDataUrl: state.qrDataUrl || null,
        playerCount: state.settings?.showPlayerCount !== false ? state.players.size : null,
        players: Array.from(state.players.values()).map(p => ({
          nickname: p.nickname,
          score: p.score,
          connected: p.connected,
        })),
      };

      // If mid-question include current question info (no correctIndex!)
      if (state.status === 'question' && state.currentQuestionIndex >= 0) {
        const q = state.questions[state.currentQuestionIndex];
        payload.currentQuestion = {
          text: q.text,
          options: q.options,
          timeLimitSeconds: q.time_limit_seconds,
          elapsedMs: Date.now() - state.questionOpenAt,
        };
      }

      socket.emit('display-state', payload);
    });

    // ── Player events ─────────────────────────────────────────────────────────

    socket.on('join-lobby', ({ pin, nickname } = {}) => {
      const state = gameManager.getState();

      if (!state || state.pin !== pin) {
        return socket.emit('join-error', { message: 'Session not found' });
      }
      const maxPlayers = state.settings?.maxPlayers ?? 30;
      if (state.status !== 'lobby') {
        if (!state.settings?.allowLateJoins) {
          return socket.emit('join-error', { message: 'Session has already started' });
        }
      }
      if (state.players.size >= maxPlayers) {
        return socket.emit('join-error', { message: 'Session is full' });
      }

      const trimmed = (nickname ?? '').trim();
      if (!trimmed || trimmed.length > 20) {
        return socket.emit('join-error', { message: 'Nickname must be 1–20 chars' });
      }
      if (state.settings?.profanityFilter && isProfane(trimmed)) {
        return socket.emit('join-error', { message: 'Nickname contains inappropriate language' });
      }

      // Check for existing player with same nickname (case-insensitive reconnect)
      let existingEntry = null;
      for (const [, p] of state.players.entries()) {
        if (p.nickname.toLowerCase() === trimmed.toLowerCase()) {
          existingEntry = p;
          break;
        }
      }

      if (existingEntry) {
        // Reconnect path — update socket mapping
        const oldSocketId = existingEntry.socketId;
        if (oldSocketId) state.players.delete(oldSocketId);
        existingEntry.socketId = socket.id;
        existingEntry.connected = true;
        state.players.set(socket.id, existingEntry);
        db.updatePlayerSocketId(existingEntry.playerId, socket.id);
        db.setPlayerConnected(existingEntry.playerId, true);

        socket.join(`session:${pin}`);
        socket.emit('join-success', {
          playerId: existingEntry.playerId,
          nickname: existingEntry.nickname,
          playerCount: state.settings?.showPlayerCount !== false ? state.players.size : null,
        });
      } else {
        // New player
        const player = db.createPlayer(state.sessionId, trimmed, socket.id);
        state.players.set(socket.id, {
          playerId: player.id,
          nickname: trimmed,
          score: 0,
          streak: 0,
          connected: true,
          socketId: socket.id,
        });

        socket.join(`session:${pin}`);
        socket.emit('join-success', {
          playerId: player.id,
          nickname: trimmed,
          playerCount: state.settings?.showPlayerCount !== false ? state.players.size : null,
        });
      }

      // Broadcast lobby update to everyone in session
      io.to(`session:${pin}`).emit('lobby-update', {
        players: Array.from(state.players.values()).map(p => ({ nickname: p.nickname })),
        playerCount: state.settings?.showPlayerCount !== false ? state.players.size : null,
      });
    });

    socket.on('submit-answer', ({ optionIndex } = {}) => {
      const state = gameManager.getState();
      if (!state || state.status !== 'question') {
        return socket.emit('answer-locked', { message: 'Question is no longer accepting answers' });
      }

      const result = gameManager.submitAnswer(socket.id, Number(optionIndex));
      if (!result) return; // already answered or not in session

      socket.emit('answer-accepted', { optionIndex });

      // Broadcast tally to host
      const pin = state.pin;
      const tally = [0, 0, 0, 0];
      for (const ans of state.answers.values()) {
        if (ans.optionIndex >= 0 && ans.optionIndex <= 3) tally[ans.optionIndex]++;
      }
      const connectedCount = Array.from(state.players.values()).filter(p => p.connected).length;
      const answeredNicknames = [];
      for (const player of state.players.values()) {
        if (state.answers.has(player.playerId)) answeredNicknames.push(player.nickname);
      }
      io.to(`host:${pin}`).emit('answer-tally-update', {
        tally,
        totalAnswered: state.answers.size,
        totalPlayers: connectedCount,
        answeredNicknames,
      });

      // Auto-reveal when all connected players answered
      if (state.answers.size >= connectedCount && connectedCount > 0) {
        _clearAutoTimers();
        _revealWithDelay(io, pin, gameManager);
      }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      const player = gameManager.playerDisconnected(socket.id);
      if (player) {
        db.setPlayerConnected(player.playerId, false);
        const state = gameManager.getState();
        if (state) {
          io.to(`session:${state.pin}`).emit('lobby-update', {
            players: Array.from(state.players.values()).map(p => ({ nickname: p.nickname })),
            playerCount: state.settings?.showPlayerCount !== false ? state.players.size : null,
          });
        }
      }
    });
  });
}

function _handleHostNext(io, pin, gameManager, socket) {
  const state = gameManager.getState();
  if (!state || state.pin !== pin) {
    return socket.emit('error', { message: 'No active session' });
  }

  switch (state.status) {
    case 'lobby': {
      _clearAutoTimers();
      _startNextQuestion(io, pin, gameManager);
      break;
    }
    case 'question': {
      _clearAutoTimers();
      _revealWithDelay(io, pin, gameManager);
      break;
    }
    case 'reveal': {
      _clearAutoTimers();
      _emitLeaderboard(io, pin, gameManager);
      break;
    }
    case 'leaderboard': {
      _clearAutoTimers();
      const nextIdx = state.currentQuestionIndex + 1;
      if (nextIdx >= state.questions.length) {
        const final = gameManager.endSession();
        io.to(`session:${pin}`).emit('game-ended', {
          podium: final.slice(0, 3),
          allPlayers: final,
          archived: false,
        });
      } else {
        _startNextQuestion(io, pin, gameManager);
      }
      break;
    }
    default:
      socket.emit('error', { message: `Cannot advance from status: ${state.status}` });
  }
}

module.exports = {
  registerHandlers,
  revealWithDelay:    _revealWithDelay,
  emitLeaderboard:   _emitLeaderboard,
  startNextQuestion: _startNextQuestion,
  clearAutoTimers:   _clearAutoTimers,
};
