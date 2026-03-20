'use strict';
// Stress test: 20 players, 20 questions, full game loop
// Each player has a deterministic "skill level" (0.0–1.0) controlling answer correctness.
// After the game, score ordering, streak bonuses, leaderboard accuracy, and session history
// are all verified.
// Usage: node tests/stress-test.js

require('dotenv').config();
const http     = require('http');
const path     = require('path');
const Database = require('better-sqlite3');
const { io: ioClient } = require('socket.io-client');

const BASE = 'http://localhost:3000';
const HTTP = 'localhost';
const PORT = 3000;

function getPassword() {
  try {
    const dbPath = path.join(process.env.DATA_PATH || '/data', 'quiz.db');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key='host_password'").get();
    db.close();
    if (row?.value) return row.value;
  } catch {}
  return process.env.HOST_PASSWORD || 'changeme';
}

const PASSWORD = getPassword();

const NUM_PLAYERS   = 20;
const NUM_QUESTIONS = 20;

let passed = 0;
let failed = 0;

// ── helpers ────────────────────────────────────────────────────────────────────

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: HTTP, port: PORT, ...opts }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

function json(b) { try { return JSON.parse(b); } catch { return null; } }

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? '  →  ' + detail : ''}`);
    failed++;
  }
}

function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}" on ${socket.id}`)), timeoutMs);
    socket.once(event, d => { clearTimeout(t); resolve(d); });
  });
}

function connect(opts = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { transports: ['websocket'], ...opts });
    s.once('connect', () => resolve(s));
    s.once('connect_error', e => reject(e));
    setTimeout(() => reject(new Error('Socket connect timeout')), 6000);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── player model ───────────────────────────────────────────────────────────────
// Each player has a skill level 0.0–1.0 that determines:
//   - whether they answer correctly (1.0 = always correct, 0.0 = always wrong)
//   - how fast they answer (0ms–4000ms within the window)
// Player 0 has skill=1.0 (perfect), player 19 has skill=0.0 (always wrong).
// Players 0–9 answer all correctly so we can predict streak bonuses.

function makePlayer(index) {
  const skill = 1 - (index / (NUM_PLAYERS - 1)); // 1.0 down to 0.0
  return {
    index,
    nickname: `Player${String(index + 1).padStart(2, '0')}`,
    skill,
    // Answer delay in ms: skill=1.0 → 0ms (immediate), skill=0.0 → 100ms (slow)
    // Higher-skill players answer faster, earning more timed points
    delayMs: Math.round((1 - skill) * 100),
    socket: null,
    playerId: null,
    trackedScore: 0,
    trackedStreak: 0,
  };
}

// ── main ───────────────────────────────────────────────────────────────────────

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ROMEU_QUIZ  Stress Test: ${NUM_PLAYERS} players × ${NUM_QUESTIONS} questions`);
  console.log('═══════════════════════════════════════════════════════════════');

  let cookie = '';
  let quizId;
  let pin;
  let hostSocket;

  // correctIndex for each question (cycling 0-3 for variety)
  const correctIndexes = Array.from({ length: NUM_QUESTIONS }, (_, i) => i % 4);

  const players = Array.from({ length: NUM_PLAYERS }, (_, i) => makePlayer(i));

  try {
    // ── Step 1: Auth + quiz setup ─────────────────────────────────────────────
    console.log('\n── Setup ─────────────────────────────────────────────────────────');

    const loginRes = await req(
      { path: '/host/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      `password=${encodeURIComponent(PASSWORD)}`
    );
    const setCookies = loginRes.headers['set-cookie'] ?? [];
    cookie = setCookies.map(c => c.split(';')[0]).join('; ');
    const csrfToken = (setCookies.find(c => c.startsWith('csrf-token=')) ?? '').match(/^csrf-token=([^;]+)/)?.[1] ?? '';
    check('Login OK', loginRes.status === 302 && cookie.length > 0);

    const authH = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken };

    // Create quiz
    const qr = await req({ path: '/host/api/quizzes', method: 'POST', headers: authH }, { name: 'Stress Test Quiz' });
    quizId = json(qr.body)?.id;
    check('Quiz created', !!quizId);

    // Add questions — mix of MCQ and T/F
    let tfCount = 0;
    let mcqCount = 0;
    for (let i = 0; i < NUM_QUESTIONS; i++) {
      const isTF = i % 5 === 4; // every 5th question is T/F
      const ci   = isTF ? (correctIndexes[i] % 2) : correctIndexes[i];
      const body = isTF
        ? { text: `True/False Q${i + 1}: Is ${i + 1} an integer?`, type: 'truefalse', correctIndex: ci, timeLimitSeconds: 10, explanation: `Yes, ${i + 1} is an integer.` }
        : { text: `MCQ Q${i + 1}: Which option is option ${(ci + 1)}?`, options: ['Option 1', 'Option 2', 'Option 3', 'Option 4'], correctIndex: ci, timeLimitSeconds: 10, explanation: `Option ${ci + 1} is correct.` };
      const r = await req({ path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authH }, body);
      if (r.status !== 201) { console.error(`  FAIL  Q${i + 1} creation failed: ${r.body.slice(0, 80)}`); failed++; }
      if (isTF) tfCount++; else mcqCount++;
    }
    check(`${NUM_QUESTIONS} questions created (${mcqCount} MCQ, ${tfCount} T/F)`,
      mcqCount + tfCount === NUM_QUESTIONS);

    // Start session
    const sessR = await req({ path: '/host/api/session/start', method: 'POST', headers: authH }, { quizId });
    check('Session started', sessR.status === 201);
    pin = json(sessR.body)?.pin;
    check('PIN received', typeof pin === 'string' && pin.length > 0, pin);

    // ── Step 2: Connect all sockets ───────────────────────────────────────────
    console.log('\n── Connecting 20 players ─────────────────────────────────────────');

    hostSocket = await connect({ extraHeaders: { cookie } });

    // Connect all players in parallel
    await Promise.all(players.map(async p => { p.socket = await connect(); }));
    check(`${NUM_PLAYERS} player sockets connected`, players.every(p => p.socket?.connected));

    // Host joins
    const hostStateP = waitFor(hostSocket, 'host-state');
    hostSocket.emit('host-join', { pin });
    const hostState = await hostStateP;
    check('Host joined, status=lobby', hostState?.status === 'lobby');

    // All players join lobby concurrently
    const joinResults = await Promise.all(players.map(p => {
      const joinP = waitFor(p.socket, 'join-success', 6000);
      p.socket.emit('join-lobby', { pin, nickname: p.nickname });
      return joinP.then(d => { p.playerId = d.playerId; return d; });
    }));
    const allJoined = joinResults.every(r => !!r?.playerId);
    check(`All ${NUM_PLAYERS} players joined lobby`, allJoined, `${joinResults.filter(r => !r?.playerId).length} failures`);

    // ── Step 3: Play all 20 questions ─────────────────────────────────────────
    console.log('\n── Playing 20 questions ──────────────────────────────────────────');

    // Track expected state for each player
    // Players with skill >= 0.5 answer correctly (players 0–9), others wrong (10–19)
    const correctPlayers = players.filter(p => p.skill >= 0.5);
    const wrongPlayers   = players.filter(p => p.skill < 0.5);

    let totalRevealEvents = 0;
    let allRevealPayloadsValid = true;
    let streakBonusFiredAt3  = false;
    let streakBonusFiredAt5  = false;

    for (let qi = 0; qi < NUM_QUESTIONS; qi++) {
      const isTF = qi % 5 === 4;
      const correctIdx = isTF ? (correctIndexes[qi] % 2) : correctIndexes[qi];

      // Register question-start listeners BEFORE triggering REST (event fires immediately)
      const qStartPromises = players.map(p => waitFor(p.socket, 'question-start', 8000));
      const hostQStartP    = waitFor(hostSocket, 'question-start', 8000);

      // Trigger question via REST next
      const nextR = await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
      if (nextR.status !== 200) {
        console.error(`  FAIL  Q${qi + 1} next failed: ${nextR.body.slice(0, 80)}`);
        failed++;
        break;
      }

      // Wait for all players to receive question-start
      const qStartEvents = await Promise.all(qStartPromises);
      await hostQStartP;
      const allGotStart = qStartEvents.every(e => !!e?.text);
      if (!allGotStart) { console.error(`  FAIL  Not all players got question-start for Q${qi + 1}`); failed++; }

      // Verify type on T/F questions
      if (isTF) {
        const tfOk = qStartEvents.every(e => e?.type === 'truefalse' && e?.options?.length === 2);
        if (!tfOk) { console.error(`  FAIL  T/F Q${qi + 1} type/options wrong`); failed++; }
      }

      // Host waits for reveal (triggered by all players answering)
      const revealP = waitFor(hostSocket, 'question-reveal', 10000);

      // Submit answers: correct players answer correctly, wrong players answer wrong
      // Add small staggered delay to simulate real timing
      await Promise.all([
        ...correctPlayers.map((p, i) =>
          sleep(p.delayMs).then(() => {
            const acceptP = waitFor(p.socket, 'answer-accepted', 5000);
            p.socket.emit('submit-answer', { optionIndex: correctIdx });
            return acceptP;
          })
        ),
        ...wrongPlayers.map((p, i) => {
          const wrongIdx = (correctIdx + 1) % (isTF ? 2 : 4);
          return sleep(p.delayMs).then(() => {
            const acceptP = waitFor(p.socket, 'answer-accepted', 5000);
            p.socket.emit('submit-answer', { optionIndex: wrongIdx });
            return acceptP;
          });
        }),
      ]);

      // Wait for auto-reveal (triggered when all players have answered)
      const reveal = await revealP;
      totalRevealEvents++;

      // Validate reveal payload structure
      if (!reveal?.playerResults || reveal.correctIndex !== correctIdx) {
        allRevealPayloadsValid = false;
        console.error(`  FAIL  Q${qi + 1} reveal: correctIndex=${reveal?.correctIndex} expected=${correctIdx}`);
        failed++;
      }

      // Track expected streaks for perfect player (Player01)
      const p0Result = reveal?.playerResults?.[players[0].nickname];
      if (p0Result) {
        players[0].trackedStreak = p0Result.streak;
        players[0].trackedScore  = p0Result.newScore;
        if (p0Result.streak === 3 && p0Result.bonusPoints === 100) streakBonusFiredAt3 = true;
        if (p0Result.streak === 5 && p0Result.bonusPoints === 200) streakBonusFiredAt5 = true;
      }

      // Check explanation present on questions that have it (all do in this test)
      if (!reveal?.explanation) {
        console.error(`  FAIL  Q${qi + 1} reveal missing explanation`);
        failed++;
      }

      // Register leaderboard listener BEFORE triggering REST
      const lbP = waitFor(hostSocket, 'leaderboard-update', 6000);

      // Advance to leaderboard
      await req({ path: '/host/api/session/next', method: 'POST', headers: authH });

      // Wait for leaderboard-update on host
      await lbP;

      process.stdout.write(`  Q${String(qi + 1).padStart(2, '0')} done (streak P01: ${players[0].trackedStreak})\n`);
    }

    check(`All ${NUM_QUESTIONS} question-reveal events received`, totalRevealEvents === NUM_QUESTIONS, `got ${totalRevealEvents}`);
    check('All reveal payloads had correct correctIndex', allRevealPayloadsValid);
    check('Streak bonus +100 fired at streak=3 for Player01', streakBonusFiredAt3);
    check('Streak bonus +200 fired at streak=5 for Player01', streakBonusFiredAt5);
    check(`Player01 final streak = ${NUM_QUESTIONS} (perfect)`, players[0].trackedStreak === NUM_QUESTIONS, `got ${players[0].trackedStreak}`);

    // ── Step 4: End game ──────────────────────────────────────────────────────
    console.log('\n── Game End + Final Leaderboard ──────────────────────────────────');

    const gameEndedP = waitFor(hostSocket, 'game-ended', 8000);
    const endNextR = await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
    check('Session next → ended', endNextR.status === 200);
    const gameEnded = await gameEndedP;
    check('game-ended received', !!gameEnded);
    check('Podium has 3 entries', gameEnded?.podium?.length === 3, `got ${gameEnded?.podium?.length}`);
    // getLeaderboard() returns top 10 — allPlayers is capped at 10 by design
    const expectedAllPlayers = Math.min(NUM_PLAYERS, 10);
    check(`allPlayers has top ${expectedAllPlayers}`, gameEnded?.allPlayers?.length === expectedAllPlayers, `got ${gameEnded?.allPlayers?.length}`);

    // Player01 (perfect + fastest) must be 1st
    check('Player01 in 1st place', gameEnded?.podium?.[0]?.nickname === 'Player01', `got ${gameEnded?.podium?.[0]?.nickname}`);

    // Score ordering: allPlayers should be sorted descending
    const scores = gameEnded?.allPlayers?.map(p => p.score) ?? [];
    const isSortedDesc = scores.every((s, i) => i === 0 || s <= scores[i - 1]);
    check('Final leaderboard sorted descending by score', isSortedDesc, `scores=${scores.slice(0,5).join(',')}`);

    // Player01 must lead the top-10
    const p01score = gameEnded?.allPlayers?.find(p => p.nickname === 'Player01')?.score ?? 0;
    check('Player01 has highest score in top-10', gameEnded?.allPlayers?.[0]?.nickname === 'Player01', `first=${gameEnded?.allPlayers?.[0]?.nickname}, score=${p01score}`);

    // ── Step 5: Session history ───────────────────────────────────────────────
    console.log('\n── Session History ───────────────────────────────────────────────');

    const sessionsR = await req({ path: '/host/api/sessions', method: 'GET', headers: authH });
    check('GET /sessions → 200', sessionsR.status === 200);
    const sessions = json(sessionsR.body);
    check('Sessions list non-empty', Array.isArray(sessions) && sessions.length > 0);

    const latest = sessions[0];
    check('Latest session status=ended', latest?.status === 'ended');
    check('Latest session winner=Player01', latest?.winner_nickname === 'Player01', `got ${latest?.winner_nickname}`);
    check(`Latest session player_count=${NUM_PLAYERS}`, Number(latest?.player_count) === NUM_PLAYERS, `got ${latest?.player_count}`);

    // Verify answer breakdown
    const breakdownR = await req({ path: `/host/api/sessions/${latest.id}`, method: 'GET', headers: authH });
    check('GET /sessions/:id → 200', breakdownR.status === 200);
    const breakdown = json(breakdownR.body);
    check(`Breakdown has ${NUM_QUESTIONS} questions`, breakdown?.length === NUM_QUESTIONS, `got ${breakdown?.length}`);

    // Each question should have exactly NUM_PLAYERS total answers
    const allQsHaveFullAnswers = breakdown?.every(q => q.total === NUM_PLAYERS);
    check(`Every question has exactly ${NUM_PLAYERS} answer submissions`, allQsHaveFullAnswers,
      breakdown?.filter(q => q.total !== NUM_PLAYERS).map(q => `Q:${q.text.slice(0,20)} total=${q.total}`).join(', '));

    // Tally correctness: correct players (10) answered the right option
    const q1Breakdown = breakdown?.[0];
    if (q1Breakdown) {
      const expectedCorrect  = correctPlayers.length; // 10
      const actualCorrectTally = q1Breakdown.tally[q1Breakdown.correctIndex] ?? 0;
      check(`Q1 tally: ${expectedCorrect} correct answers recorded`, actualCorrectTally === expectedCorrect, `got ${actualCorrectTally}`);
    }

    // ── Step 6: Concurrent duplicate stress ───────────────────────────────────
    console.log('\n── Concurrent Quiz Duplicate ─────────────────────────────────────');

    // Hit duplicate 3 times simultaneously
    const dupResults = await Promise.all([1, 2, 3].map(() =>
      req({ path: `/host/api/quizzes/${quizId}/duplicate`, method: 'POST', headers: authH })
    ));
    const allDup201 = dupResults.every(r => r.status === 201);
    check('3 concurrent duplicates all return 201', allDup201, dupResults.map(r => r.status).join(','));

    const dupIds = dupResults.map(r => json(r.body)?.id).filter(Boolean);
    check('All 3 duplicates have distinct IDs', new Set(dupIds).size === 3, dupIds.join(','));

    // Verify each duplicate has 20 questions
    const dupChecks = await Promise.all(dupIds.map(id =>
      req({ path: `/host/api/quizzes/${id}`, method: 'GET', headers: authH })
    ));
    const allDupHave20 = dupChecks.every(r => json(r.body)?.questions?.length === NUM_QUESTIONS);
    check(`All 3 duplicates have ${NUM_QUESTIONS} questions`, allDupHave20);

    // Cleanup duplicates
    await Promise.all(dupIds.map(id =>
      req({ path: `/host/api/quizzes/${id}`, method: 'DELETE', headers: authH })
    ));

  } catch (err) {
    console.error('\n  FAIL  Unhandled error:', err.message);
    console.error(err.stack);
    failed++;
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────────
    console.log('\n── Cleanup ───────────────────────────────────────────────────────');
    hostSocket?.disconnect();
    players.forEach(p => p.socket?.disconnect());

    if (quizId && cookie) {
      try {
        const authH = { 'Content-Type': 'application/json', Cookie: cookie };
        await req({ path: `/host/api/quizzes/${quizId}`, method: 'DELETE', headers: authH });
        console.log('  INFO  Stress test quiz deleted');
      } catch {}
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})();
