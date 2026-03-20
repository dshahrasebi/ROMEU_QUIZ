'use strict';
// Socket integration tests — full game loop simulation
// Usage: node tests/socket-test.js

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

function json(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? '  →  ' + detail : ''}`);
    failed++;
  }
}

// Wait for a specific event on a socket, with timeout
function waitFor(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

// Connect a socket.io client and wait for 'connect'
function connect(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, { transports: ['websocket'], ...opts });
    s.once('connect', () => resolve(s));
    s.once('connect_error', e => reject(e));
    setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── main ───────────────────────────────────────────────────────────────────────

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ROMEU_QUIZ  Socket Game Loop Tests');
  console.log('═══════════════════════════════════════════════════════════════');

  let cookie = '';
  let csrfToken = '';
  let quizId;
  let pin;
  let hostSocket, displaySocket, p1Socket, p2Socket;

  try {

    // ── Step 1: Login and set up quiz ─────────────────────────────────────────
    console.log('\n── Setup ─────────────────────────────────────────────────────────');

    const loginRes = await req(
      { path: '/host/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      `password=${encodeURIComponent(PASSWORD)}`
    );
    const setCookies = loginRes.headers['set-cookie'] ?? [];
    cookie = setCookies.map(c => c.split(';')[0]).join('; ');
    csrfToken = (setCookies.find(c => c.startsWith('csrf-token=')) ?? '').match(/^csrf-token=([^;]+)/)?.[1] ?? '';
    check('Login OK', loginRes.status === 302 && cookie.length > 0);

    const authH = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken };

    // Create quiz
    const qr = await req({ path: '/host/api/quizzes', method: 'POST', headers: authH }, { name: 'Socket Test Quiz' });
    quizId = json(qr.body)?.id;
    check('Quiz created', !!quizId, `id=${quizId}`);

    // Q1 — MCQ with image + explanation (answer: index 1 = 'Paris')
    const q1r = await req(
      { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authH },
      {
        text: 'What is the capital of France?',
        options: ['London', 'Paris', 'Berlin', 'Madrid'],
        correctIndex: 1,
        timeLimitSeconds: 20,
        imageUrl: 'https://example.com/france.png',
        explanation: 'Paris is the capital of France.',
      }
    );
    check('Q1 MCQ created', q1r.status === 201);

    // Q2 — True/False (answer: 0 = True)
    const q2r = await req(
      { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authH },
      { text: 'The Eiffel Tower is in Paris.', type: 'truefalse', correctIndex: 0, timeLimitSeconds: 10 }
    );
    check('Q2 T/F created', q2r.status === 201, `status=${q2r.status}`);

    // Q3 — MCQ (answer: index 2 = '4')
    const q3r = await req(
      { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authH },
      { text: 'What is 2+2?', options: ['1','2','3','4'], correctIndex: 3, timeLimitSeconds: 15, explanation: '2+2 equals 4.' }
    );
    check('Q3 MCQ created', q3r.status === 201);

    // Start session
    const sessR = await req(
      { path: '/host/api/session/start', method: 'POST', headers: authH },
      { quizId }
    );
    check('Session started', sessR.status === 201, `status=${sessR.status} ${sessR.body.slice(0,80)}`);
    pin = json(sessR.body)?.pin;
    check('PIN received', typeof pin === 'string' && pin.length > 0);

    // ── Step 2: Connect sockets ───────────────────────────────────────────────
    console.log('\n── Socket Connections ────────────────────────────────────────────');

    hostSocket    = await connect(BASE, { extraHeaders: { cookie } });
    displaySocket = await connect(BASE);
    p1Socket      = await connect(BASE);
    p2Socket      = await connect(BASE);
    check('All 4 sockets connected', true);

    // ── Step 3: Join rooms ────────────────────────────────────────────────────
    console.log('\n── Join Rooms ────────────────────────────────────────────────────');

    const hostStateP    = waitFor(hostSocket, 'host-state');
    const displayStateP = waitFor(displaySocket, 'display-state');
    hostSocket.emit('host-join', { pin });
    displaySocket.emit('display-join', { pin });

    const hostState = await hostStateP;
    check('host-state received', !!hostState);
    check('host-state has status=lobby', hostState?.status === 'lobby', `status=${hostState?.status}`);
    check('host-state has pin', hostState?.pin === pin);

    const displayState = await displayStateP;
    check('display-state received', !!displayState);
    check('display-state has status=lobby', displayState?.status === 'lobby', `status=${displayState?.status}`);

    // player 1 joins
    const p1JoinP = waitFor(p1Socket, 'join-success');
    p1Socket.emit('join-lobby', { pin, nickname: 'Alice' });
    const p1Join = await p1JoinP;
    check('P1 join-success', !!p1Join, JSON.stringify(p1Join));
    check('P1 nickname=Alice', p1Join?.nickname === 'Alice');

    // player 2 joins
    const p2JoinP = waitFor(p2Socket, 'join-success');
    p2Socket.emit('join-lobby', { pin, nickname: 'Bob' });
    const p2Join = await p2JoinP;
    check('P2 join-success', !!p2Join);
    check('P2 nickname=Bob', p2Join?.nickname === 'Bob');

    // ── Step 4: Question 1 (MCQ with image + explanation) ─────────────────────
    console.log('\n── Q1: MCQ with image + explanation ─────────────────────────────');

    const q1StartHostP  = waitFor(hostSocket, 'question-start');
    const q1StartP1P    = waitFor(p1Socket, 'question-start');
    const q1StartDispP  = waitFor(displaySocket, 'question-start');

    // Trigger via REST (host-next) instead of socket to avoid auth middleware complexity
    const nextR1 = await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
    check('Session next → 200 (lobby→question)', nextR1.status === 200, `status=${nextR1.status}`);

    const q1Start = await q1StartHostP;
    await q1StartP1P;
    const q1StartDisp = await q1StartDispP;

    check('question-start: text matches', q1Start?.text === 'What is the capital of France?', q1Start?.text);
    check('question-start: type=mcq', q1Start?.type === 'mcq', q1Start?.type);
    check('question-start: imageUrl present', q1Start?.imageUrl === 'https://example.com/france.png', q1Start?.imageUrl);
    check('question-start: 4 options', q1Start?.options?.length === 4);
    check('question-start display also gets imageUrl', q1StartDisp?.imageUrl === 'https://example.com/france.png');

    // P1 submits CORRECT answer (index 1 = Paris)
    const p1AcceptP  = waitFor(p1Socket, 'answer-accepted');
    const q1RevealP  = waitFor(hostSocket, 'question-reveal', 8000);
    p1Socket.emit('submit-answer', { optionIndex: 1 });
    const p1Accept = await p1AcceptP;
    check('P1 answer-accepted', p1Accept?.optionIndex === 1, JSON.stringify(p1Accept));

    // P2 submits WRONG answer (index 0 = London)
    const p2AcceptP = waitFor(p2Socket, 'answer-accepted');
    p2Socket.emit('submit-answer', { optionIndex: 0 });
    await p2AcceptP;
    check('P2 answer-accepted', true);

    // Both answered → auto-reveal should fire
    const q1Reveal = await q1RevealP;
    check('question-reveal: correctIndex=1', q1Reveal?.correctIndex === 1, `got ${q1Reveal?.correctIndex}`);
    check('question-reveal: explanation present', q1Reveal?.explanation === 'Paris is the capital of France.', q1Reveal?.explanation);
    check('question-reveal: answerCounts present', Array.isArray(q1Reveal?.answerCounts));
    check('question-reveal: P1 in playerResults', !!q1Reveal?.playerResults?.Alice);
    check('question-reveal: P1 correct', q1Reveal?.playerResults?.Alice?.correct === true);
    check('question-reveal: P1 chosenIndex=1', q1Reveal?.playerResults?.Alice?.chosenIndex === 1, `got ${q1Reveal?.playerResults?.Alice?.chosenIndex}`);
    check('question-reveal: P1 streak=1', q1Reveal?.playerResults?.Alice?.streak === 1, `got ${q1Reveal?.playerResults?.Alice?.streak}`);
    check('question-reveal: P1 bonusPoints=0 (streak<3)', q1Reveal?.playerResults?.Alice?.bonusPoints === 0, `got ${q1Reveal?.playerResults?.Alice?.bonusPoints}`);
    check('question-reveal: P2 correct=false', q1Reveal?.playerResults?.Bob?.correct === false);

    // ── Step 5: Leaderboard after Q1 ─────────────────────────────────────────
    console.log('\n── Leaderboard After Q1 ─────────────────────────────────────────');

    const lb1P = waitFor(hostSocket, 'leaderboard-update');
    const nextR2 = await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
    check('Session next → 200 (reveal→leaderboard)', nextR2.status === 200);
    const lb1 = await lb1P;
    check('leaderboard-update received', !!lb1);
    check('leaderboard: Alice comes first', lb1?.leaderboard?.[0]?.nickname === 'Alice', JSON.stringify(lb1?.leaderboard));
    check('leaderboard: Alice score > 0', (lb1?.leaderboard?.[0]?.score ?? 0) > 0);

    // ── Step 6: Question 2 (T/F) ──────────────────────────────────────────────
    console.log('\n── Q2: True/False ────────────────────────────────────────────────');

    const q2StartP       = waitFor(hostSocket, 'question-start');
    const q2StartP1P     = waitFor(p1Socket, 'question-start');
    const q2StartDispP   = waitFor(displaySocket, 'question-start');

    const nextR3 = await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
    check('Session next → 200 (leaderboard→Q2)', nextR3.status === 200);

    const q2Start = await q2StartP;
    await q2StartP1P;
    await q2StartDispP;
    check('Q2 question-start: type=truefalse', q2Start?.type === 'truefalse', `got ${q2Start?.type}`);
    check('Q2 question-start: exactly 2 options', q2Start?.options?.length === 2, `got ${q2Start?.options?.length}`);
    check('Q2 options are True/False', JSON.stringify(q2Start?.options) === JSON.stringify(['True','False']), JSON.stringify(q2Start?.options));

    // P1 submits CORRECT T/F answer (index 0 = True)
    const p1AcceptQ2P = waitFor(p1Socket, 'answer-accepted');
    const q2RevealP   = waitFor(hostSocket, 'question-reveal', 8000);
    p1Socket.emit('submit-answer', { optionIndex: 0 });
    await p1AcceptQ2P;

    // P2 submits WRONG (index 1 = False)
    const p2AcceptQ2P = waitFor(p2Socket, 'answer-accepted');
    p2Socket.emit('submit-answer', { optionIndex: 1 });
    await p2AcceptQ2P;

    const q2Reveal = await q2RevealP;
    check('Q2 reveal: correctIndex=0', q2Reveal?.correctIndex === 0, `got ${q2Reveal?.correctIndex}`);
    check('Q2 reveal: P1 streak=2', q2Reveal?.playerResults?.Alice?.streak === 2, `got ${q2Reveal?.playerResults?.Alice?.streak}`);
    check('Q2 reveal: P1 bonusPoints=0 (streak=2 < 3)', q2Reveal?.playerResults?.Alice?.bonusPoints === 0, `got ${q2Reveal?.playerResults?.Alice?.bonusPoints}`);
    check('Q2 reveal: P2 streak reset to 0', q2Reveal?.playerResults?.Bob?.streak === 0, `got ${q2Reveal?.playerResults?.Bob?.streak}`);

    // ── Step 7: Leaderboard after Q2 ─────────────────────────────────────────
    console.log('\n── Leaderboard After Q2 ─────────────────────────────────────────');
    const lb2P = waitFor(hostSocket, 'leaderboard-update');
    await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
    await lb2P;

    // ── Step 8: Question 3 (MCQ — streak bonus should fire!) ─────────────────
    console.log('\n── Q3: MCQ — Streak Bonus ────────────────────────────────────────');

    const q3StartP       = waitFor(hostSocket, 'question-start');
    const q3StartP1P     = waitFor(p1Socket, 'question-start');

    const nextR5 = await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
    check('Session next → 200 (leaderboard→Q3)', nextR5.status === 200);
    await q3StartP;
    await q3StartP1P;

    // P1 submits CORRECT (index 3 = '4')
    const p1AcceptQ3P = waitFor(p1Socket, 'answer-accepted');
    const q3RevealP   = waitFor(hostSocket, 'question-reveal', 8000);
    p1Socket.emit('submit-answer', { optionIndex: 3 });
    await p1AcceptQ3P;

    // P2 submits wrong (index 0)
    const p2AcceptQ3P = waitFor(p2Socket, 'answer-accepted');
    p2Socket.emit('submit-answer', { optionIndex: 0 });
    await p2AcceptQ3P;

    const q3Reveal = await q3RevealP;
    check('Q3 reveal received', !!q3Reveal);
    check('Q3 reveal: P1 streak=3', q3Reveal?.playerResults?.Alice?.streak === 3, `got ${q3Reveal?.playerResults?.Alice?.streak}`);
    check('🔥 Q3 reveal: P1 bonusPoints=100 (streak=3)', q3Reveal?.playerResults?.Alice?.bonusPoints === 100, `got ${q3Reveal?.playerResults?.Alice?.bonusPoints}`);
    check('Q3 reveal: explanation="2+2 equals 4."', q3Reveal?.explanation === '2+2 equals 4.', `got ${q3Reveal?.explanation}`);
    check('Q3 reveal: P1 correct=true', q3Reveal?.playerResults?.Alice?.correct === true);

    // ── Step 9: Final leaderboard → game-ended ────────────────────────────────
    console.log('\n── Game End ──────────────────────────────────────────────────────');

    const lb3P     = waitFor(hostSocket, 'leaderboard-update');
    await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
    await lb3P;

    const gameEndedP = waitFor(hostSocket, 'game-ended', 5000);
    const endNext = await req({ path: '/host/api/session/next', method: 'POST', headers: authH });
    check('Session next → ended', endNext.status === 200);
    const gameEnded = await gameEndedP;
    check('game-ended received', !!gameEnded);
    check('game-ended: podium is array', Array.isArray(gameEnded?.podium));
    check('game-ended: Alice is on podium', gameEnded?.podium?.some(p => p.nickname === 'Alice'));
    check('game-ended: Alice in first place', gameEnded?.podium?.[0]?.nickname === 'Alice', `first=${gameEnded?.podium?.[0]?.nickname}`);

  } catch (err) {
    console.error('\n  FAIL  Unhandled error:', err.message);
    failed++;
  } finally {

    // ── Cleanup ───────────────────────────────────────────────────────────────
    console.log('\n── Cleanup ───────────────────────────────────────────────────────');
    [hostSocket, displaySocket, p1Socket, p2Socket].forEach(s => s?.disconnect());

    if (quizId && cookie) {
      try {
        const authH = { 'Content-Type': 'application/json', Cookie: cookie };
        await req({ path: `/host/api/quizzes/${quizId}`, method: 'DELETE', headers: authH });
        console.log('  INFO  Test quiz deleted');
      } catch {}
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})();
