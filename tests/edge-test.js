'use strict';
// Edge case + validation tests — attempts to break the server
// Usage: node tests/edge-test.js

require('dotenv').config();
const http   = require('http');
const path   = require('path');
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
let cookie  = '';
let csrfToken = '';

// ── helpers ────────────────────────────────────────────────────────────────────

function extractCsrf(setCookieArray) {
  for (const c of (Array.isArray(setCookieArray) ? setCookieArray : [])) {
    const m = c.match(/^csrf-token=([^;]+)/);
    if (m) return m[1];
  }
  return '';
}

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

function waitFor(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, d => { clearTimeout(t); resolve(d); });
  });
}

function connect(opts = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { transports: ['websocket'], ...opts });
    s.once('connect', () => resolve(s));
    s.once('connect_error', e => reject(e));
    setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
  });
}

// ── tests ──────────────────────────────────────────────────────────────────────

async function setup() {
  const loginRes = await req(
    { path: '/host/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    `password=${encodeURIComponent(PASSWORD)}`
  );
  const setCookies = loginRes.headers['set-cookie'] ?? [];
  cookie = setCookies.map(c => c.split(';')[0]).join('; ');
  csrfToken = extractCsrf(setCookies);
  check('Login for edge tests', loginRes.status === 302 && cookie.length > 0);
}

async function testPUTTFCorrectIndexBug() {
  console.log('\n── Known Bug: PUT T/F correct_index validation ───────────────────');
  console.log('  INFO  Audit found PUT /questions/:id allows correct_index=3 for truefalse type');
  console.log('  INFO  Expected: 400 when type=truefalse and correct_index > 1');

  const authH = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken };

  // Create a quiz + T/F question
  const quiz = json((await req({ path: '/host/api/quizzes', method: 'POST', headers: authH }, { name: 'Edge Bug Quiz' })).body);
  const qr = await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Is this a test?', type: 'truefalse', correctIndex: 0, timeLimitSeconds: 10 }
  );
  const q = json(qr.body);

  // Attempt PUT with type=truefalse and correct_index=3 — should be 400
  const badPut = await req(
    { path: `/host/api/questions/${q.id}`, method: 'PUT', headers: authH },
    { type: 'truefalse', correct_index: 3 }
  );

  if (badPut.status === 400) {
    check('PUT T/F correct_index=3 → 400 (bug fixed or not present)', true);
  } else {
    console.error(`  BUG   PUT T/F correct_index=3 → ${badPut.status} (allows out-of-range index for T/F — KNOWN BUG)`);
    failed++;
    console.log('  INFO  Flagging for fix: PUT /questions/:id should validate correct_index 0-1 when type=truefalse');
  }

  // Clean up
  await req({ path: `/host/api/quizzes/${quiz.id}`, method: 'DELETE', headers: authH });
  return badPut.status;
}

async function testProtectedRoutes() {
  console.log('\n── Protected Routes Without Auth ─────────────────────────────────');

  const routes = [
    { path: '/host/api/quizzes', method: 'GET' },
    { path: '/host/api/quizzes', method: 'POST' },
    { path: '/host/api/quizzes/1', method: 'PUT' },
    { path: '/host/api/quizzes/1', method: 'DELETE' },
    { path: '/host/api/session/start', method: 'POST' },
    { path: '/host/api/session/next', method: 'POST' },
    { path: '/host/api/session/reveal', method: 'POST' },
    { path: '/host/api/session/end', method: 'POST' },
    { path: '/host/api/sessions', method: 'GET' },
    { path: '/host/api/sessions/1', method: 'GET' },
    { path: '/host/api/quizzes/1/duplicate', method: 'POST' },
  ];

  for (const { path, method } of routes) {
    const r = await req({ path, method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    check(`${method} ${path} without auth → 401`, r.status === 401, `got ${r.status}`);
  }
}

async function testSessionStartValidation() {
  console.log('\n── Session Start Validation ──────────────────────────────────────');
  const authH = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken };

  // Duplicate session: second start attempt while one is already active should still return 201
  // (or 500 — depends on implementation)
  const quiz = json((await req({ path: '/host/api/quizzes', method: 'POST', headers: authH }, { name: 'Dup Session Quiz' })).body);
  await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 10 }
  );

  const s1 = await req({ path: '/host/api/session/start', method: 'POST', headers: authH }, { quizId: quiz.id });
  check('First session start → 201', s1.status === 201, `status=${s1.status}`);
  const pin1 = json(s1.body)?.pin;

  // End the session before cleanup
  await req({ path: '/host/api/session/end', method: 'POST', headers: authH });

  await req({ path: `/host/api/quizzes/${quiz.id}`, method: 'DELETE', headers: authH });
}

async function testSocketEdgeCases() {
  console.log('\n── Socket Edge Cases ─────────────────────────────────────────────');

  const authH = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken };

  // Create a minimal quiz + session
  const quiz = json((await req({ path: '/host/api/quizzes', method: 'POST', headers: authH }, { name: 'Socket Edge Quiz' })).body);
  await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Edge Q?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 30 }
  );
  const sessR = await req({ path: '/host/api/session/start', method: 'POST', headers: authH }, { quizId: quiz.id });
  const pin = json(sessR.body)?.pin;
  check('Edge quiz session started', !!pin);

  // ── Test: join with empty nickname ──────────────────────────────────────────
  const s1 = await connect();
  const joinErrP1 = waitFor(s1, 'join-error');
  s1.emit('join-lobby', { pin, nickname: '' });
  const joinErr1 = await joinErrP1;
  check('Empty nickname → join-error', !!joinErr1?.message, joinErr1?.message);
  s1.disconnect();

  // ── Test: join with 21-char nickname ───────────────────────────────────────
  const s2 = await connect();
  const joinErrP2 = waitFor(s2, 'join-error');
  s2.emit('join-lobby', { pin, nickname: 'a'.repeat(21) });
  const joinErr2 = await joinErrP2;
  check('21-char nickname → join-error', !!joinErr2?.message, joinErr2?.message);
  s2.disconnect();

  // ── Test: join with wrong PIN ──────────────────────────────────────────────
  const s3 = await connect();
  const joinErrP3 = waitFor(s3, 'join-error');
  s3.emit('join-lobby', { pin: 'WRONG', nickname: 'Test' });
  const joinErr3 = await joinErrP3;
  check('Wrong PIN → join-error', !!joinErr3?.message, joinErr3?.message);
  s3.disconnect();

  // ── Test: submit-answer outside question phase (still in lobby) ────────────
  const s4 = await connect();
  // Join first so we have a valid socket in the session
  const s4JoinP = waitFor(s4, 'join-success');
  s4.emit('join-lobby', { pin, nickname: 'EdgePlayer' });
  await s4JoinP;

  // Submit answer while in lobby (not question phase) — expect answer-locked
  const ansLockP = waitFor(s4, 'answer-locked', 3000);
  s4.emit('submit-answer', { optionIndex: 0 });
  const ansLock = await ansLockP;
  check('submit-answer in lobby phase → answer-locked', !!ansLock?.message, ansLock?.message);

  // ── Test: host socket unauthenticated ──────────────────────────────────────
  const s5 = await connect(); // no cookie
  const errP = waitFor(s5, 'error');
  s5.emit('host-join', { pin });
  const sockErr = await errP;
  check('Unauthenticated host-join → socket error', !!sockErr?.message, sockErr?.message);
  s5.disconnect();

  // ── Test: join 31 players ─────────────────────────────────────────────────
  console.log('\n── 31-Player Limit ───────────────────────────────────────────────');

  // Join 30 players
  const playerSockets = [];
  for (let i = 0; i < 29; i++) {  // EdgePlayer already joined (1), so join 29 more = 30 total
    const ps = await connect();
    const jpP = waitFor(ps, 'join-success', 3000);
    ps.emit('join-lobby', { pin, nickname: `P${i + 1}` });
    try { await jpP; } catch { /* might fail if session fills up */ }
    playerSockets.push(ps);
  }

  // 31st player should get join-error
  const s31 = await connect();
  const joinErr31P = waitFor(s31, 'join-error', 3000);
  s31.emit('join-lobby', { pin, nickname: 'Player31' });
  try {
    const joinErr31 = await joinErr31P;
    check('31st player → join-error (session full)', !!joinErr31?.message, joinErr31?.message);
  } catch {
    check('31st player → join-error (session full)', false, 'No error received within timeout');
  }

  // Cleanup
  s31.disconnect();
  s4.disconnect();
  playerSockets.forEach(ps => ps.disconnect());

  // End session and delete quiz
  await req({ path: '/host/api/session/end', method: 'POST', headers: authH });
  await req({ path: `/host/api/quizzes/${quiz.id}`, method: 'DELETE', headers: authH });
}

async function testQuestionValidationEdgeCases() {
  console.log('\n── Question Validation Edge Cases ────────────────────────────────');
  const authH = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken };

  const quiz = json((await req({ path: '/host/api/quizzes', method: 'POST', headers: authH }, { name: 'Validation Quiz' })).body);

  // timeLimitSeconds boundary: 5 (valid)
  const r5 = await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 5 }
  );
  check('timeLimitSeconds=5 (min) → 201', r5.status === 201);

  // timeLimitSeconds boundary: 120 (valid)
  const r120 = await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q2?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 120 }
  );
  check('timeLimitSeconds=120 (max) → 201', r120.status === 201);

  // timeLimitSeconds=121 → 400
  const r121 = await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q3?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 121 }
  );
  check('timeLimitSeconds=121 → 400', r121.status === 400);

  // MCQ with empty-string option → 400
  const rEmpty = await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q4?', options: ['a','','c','d'], correctIndex: 0, timeLimitSeconds: 20 }
  );
  check('MCQ with empty option → 400', rEmpty.status === 400);

  // PUT with options array of 2 (valid for T/F style)
  const q = json((await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q5?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 20 }
  )).body);
  const putOpts2 = await req(
    { path: `/host/api/questions/${q.id}`, method: 'PUT', headers: authH },
    { options: ['Yes', 'No'] }
  );
  check('PUT options=[2 items] → 200', putOpts2.status === 200);

  // PUT with options array of 3 → 400
  const putOpts3 = await req(
    { path: `/host/api/questions/${q.id}`, method: 'PUT', headers: authH },
    { options: ['a', 'b', 'c'] }
  );
  check('PUT options=[3 items] → 400', putOpts3.status === 400);

  // time_limit_seconds via PUT
  const putTLS4 = await req(
    { path: `/host/api/questions/${q.id}`, method: 'PUT', headers: authH },
    { time_limit_seconds: 4 }
  );
  check('PUT time_limit_seconds=4 → 400', putTLS4.status === 400);

  await req({ path: `/host/api/quizzes/${quiz.id}`, method: 'DELETE', headers: authH });
}

// ── runner ─────────────────────────────────────────────────────────────────────

async function testSecurityHardening() {
  console.log('\n── Security Hardening ────────────────────────────────────────────');

  // ── CSRF: missing token → 403 ──────────────────────────────────────────────
  const noCsrfH = { 'Content-Type': 'application/json', Cookie: cookie }; // no X-CSRF-Token
  const noCsrf = await req({ path: '/host/api/quizzes', method: 'POST', headers: noCsrfH }, { name: 'Bad Quiz' });
  check('POST without CSRF token → 403', noCsrf.status === 403, `status=${noCsrf.status}`);

  // ── CSRF: wrong token → 403 ────────────────────────────────────────────────
  const wrongCsrfH = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': 'wrongtoken' };
  const wrongCsrf = await req({ path: '/host/api/quizzes', method: 'POST', headers: wrongCsrfH }, { name: 'Bad Quiz' });
  check('POST with wrong CSRF token → 403', wrongCsrf.status === 403, `status=${wrongCsrf.status}`);

  // ── imageUrl: javascript: scheme → 400 ────────────────────────────────────
  const authH = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken };
  const quiz = json((await req({ path: '/host/api/quizzes', method: 'POST', headers: authH }, { name: 'ImgUrl Test' })).body);
  const badImg = await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 10, imageUrl: 'javascript:alert(1)' }
  );
  check('imageUrl: javascript: → 400', badImg.status === 400, `status=${badImg.status}`);

  // ── imageUrl: data: scheme → 400 ──────────────────────────────────────────
  const dataImg = await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 10, imageUrl: 'data:text/html,<h1>xss</h1>' }
  );
  check('imageUrl: data: → 400', dataImg.status === 400, `status=${dataImg.status}`);

  // ── imageUrl: valid https → 201 ────────────────────────────────────────────
  const goodImg = await req(
    { path: `/host/api/quizzes/${quiz.id}/questions`, method: 'POST', headers: authH },
    { text: 'Q?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 10, imageUrl: 'https://example.com/img.png' }
  );
  check('imageUrl: https:// → 201', goodImg.status === 201, `status=${goodImg.status}`);

  // Cleanup
  await req({ path: `/host/api/quizzes/${quiz.id}`, method: 'DELETE', headers: authH });
}

// ── Settings API Tests ────────────────────────────────────────────────────────

async function testSettingsAPI() {
  console.log('\n── Settings API ──────────────────────────────────────────────────');

  // Public endpoint needs no auth
  const pub = await req({ path: '/api/settings/public', method: 'GET' });
  check('GET /api/settings/public → 200', pub.status === 200, `status=${pub.status}`);
  const pubData = json(pub.body);
  check('Public settings has platform_name', pubData && 'platform_name' in pubData, `keys=${Object.keys(pubData || {}).join(',')}`);
  check('Public settings has accent_color', pubData && 'accent_color' in pubData);
  check('Public settings has no max_players', pubData && !('max_players' in pubData), `keys=${Object.keys(pubData || {}).join(',')}`);

  // Get current settings (auth required)
  const authH = { Cookie: cookie, 'x-csrf-token': csrfToken, 'Content-Type': 'application/json' };
  const all = await req({ path: '/host/api/settings', method: 'GET', headers: { Cookie: cookie } });
  check('GET /host/api/settings (auth) → 200', all.status === 200, `status=${all.status}`);
  const allData = json(all.body);
  check('Settings has max_players key', allData && 'max_players' in allData);
  check('Settings has streak_bonus_3 key', allData && 'streak_bonus_3' in allData);

  // Valid PUT — update platform_name
  const putOk = await req({ path: '/host/api/settings', method: 'PUT', headers: authH },
    { platform_name: 'Test Platform' });
  check('PUT valid platform_name → 200', putOk.status === 200, `status=${putOk.status}`);
  const putData = json(putOk.body);
  check('PUT response has ok:true', putData && putData.ok === true);

  // Restore
  await req({ path: '/host/api/settings', method: 'PUT', headers: authH }, { platform_name: 'ROMEU QUIZ' });

  // Invalid color → 400
  const badColor = await req({ path: '/host/api/settings', method: 'PUT', headers: authH },
    { accent_color: 'notacolor' });
  check('PUT invalid accent_color → 400', badColor.status === 400, `status=${badColor.status}`);
  const colorErr = json(badColor.body);
  check('Bad color response has errors object', colorErr && typeof colorErr.errors === 'object');

  // Unknown key → 400
  const badKey = await req({ path: '/host/api/settings', method: 'PUT', headers: authH },
    { totally_unknown_key: 'value' });
  check('PUT unknown key → 400', badKey.status === 400, `status=${badKey.status}`);

  // Integer out of range → 400
  const badInt = await req({ path: '/host/api/settings', method: 'PUT', headers: authH },
    { max_players: '999' });
  check('PUT max_players=999 → 400', badInt.status === 400, `status=${badInt.status}`);

  // Unauthenticated PUT → rejected (401 or 302 redirect to login)
  const unauth = await req({ path: '/host/api/settings', method: 'PUT',
    headers: { 'Content-Type': 'application/json' } }, { platform_name: 'Hacked' });
  check('PUT settings without auth → rejected', unauth.status === 401 || unauth.status === 302 || unauth.status === 403, `status=${unauth.status}`);
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ROMEU_QUIZ  Edge Case + Validation Tests');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    await setup();
    const bugStatus = await testPUTTFCorrectIndexBug();
    await testProtectedRoutes();
    await testSessionStartValidation();
    await testQuestionValidationEdgeCases();
    await testSocketEdgeCases();
    await testSecurityHardening();
    await testSettingsAPI();

    // Report bug status explicitly
    if (bugStatus !== 400) {
      console.log('\n  BUG REPORT: PUT /questions/:id does not enforce correct_index 0-1 for T/F type');
      console.log('  Fix needed in server.js: when type===truefalse, reject correct_index > 1');
    }
  } catch (err) {
    console.error('\n  FAIL  Unhandled error:', err.message, err.stack);
    failed++;
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})();
