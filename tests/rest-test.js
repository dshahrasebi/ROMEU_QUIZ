'use strict';
// REST integration tests — run against live server on localhost:3000
// Usage: node tests/rest-test.js

require('dotenv').config();
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

const BASE = 'localhost';
const PORT = 3000;

// Read the effective password the same way the server does (DB overrides .env)
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
let cookie = '';
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
    const r = http.request({ hostname: BASE, port: PORT, ...opts }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

function authHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken, ...extra };
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

function json(body) {
  try { return JSON.parse(body); } catch { return null; }
}

// ── test groups ────────────────────────────────────────────────────────────────

async function testHealth() {
  console.log('\n── Health ────────────────────────────────────────────────────────');
  const r = await req({ path: '/health', method: 'GET' });
  check('GET /health → 200', r.status === 200);
  check('GET /health → {status:"ok"}', json(r.body)?.status === 'ok');
}

async function testAuth() {
  console.log('\n── Auth ──────────────────────────────────────────────────────────');

  // Bad password
  const bad = await req(
    { path: '/host/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    'password=wrongpassword'
  );
  check('POST /host/login bad password → redirect to /host/login?error=1',
    bad.status === 302 && bad.headers.location?.includes('error=1'), `status=${bad.status} loc=${bad.headers.location}`);

  // Good password
  const good = await req(
    { path: '/host/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    `password=${encodeURIComponent(PASSWORD)}`
  );
  check('POST /host/login good password → redirect to /host/', good.status === 302 && good.headers.location === '/host/', `status=${good.status} loc=${good.headers.location}`);
  const setCookies = good.headers['set-cookie'] ?? [];
  cookie = setCookies.map(c => c.split(';')[0]).join('; ');
  csrfToken = extractCsrf(setCookies);
  check('Session cookie received', cookie.length > 0);
  check('CSRF token received', csrfToken.length > 0);

  // Protected route without cookie
  const noAuth = await req({ path: '/host/api/quizzes', method: 'GET', headers: { Accept: 'application/json' } });
  check('GET /host/api/quizzes without cookie → 401', noAuth.status === 401, `status=${noAuth.status}`);
}

async function testQuizCRUD() {
  console.log('\n── Quiz CRUD ─────────────────────────────────────────────────────');

  // Validation
  const emptyName = await req({ path: '/host/api/quizzes', method: 'POST', headers: authHeaders() }, { name: '' });
  check('POST /quizzes empty name → 400', emptyName.status === 400);

  const longName = await req({ path: '/host/api/quizzes', method: 'POST', headers: authHeaders() }, { name: 'x'.repeat(101) });
  check('POST /quizzes 101-char name → 400', longName.status === 400);

  // Create
  const create = await req({ path: '/host/api/quizzes', method: 'POST', headers: authHeaders() }, { name: 'Test Quiz REST' });
  check('POST /quizzes → 201', create.status === 201);
  const quiz = json(create.body);
  check('POST /quizzes returns id+name', quiz?.id && quiz?.name === 'Test Quiz REST');
  const quizId = quiz?.id;

  // List
  const list = await req({ path: '/host/api/quizzes', method: 'GET', headers: authHeaders() });
  check('GET /quizzes → 200 array', list.status === 200 && Array.isArray(json(list.body)));

  // Get
  const get = await req({ path: `/host/api/quizzes/${quizId}`, method: 'GET', headers: authHeaders() });
  check('GET /quizzes/:id → 200', get.status === 200);
  check('GET /quizzes/:id has questions array', Array.isArray(json(get.body)?.questions));

  // Get 404
  const get404 = await req({ path: '/host/api/quizzes/999999', method: 'GET', headers: authHeaders() });
  check('GET /quizzes/999999 → 404', get404.status === 404);

  // Update
  const put = await req({ path: `/host/api/quizzes/${quizId}`, method: 'PUT', headers: authHeaders() }, { name: 'Renamed Quiz' });
  check('PUT /quizzes/:id → 200', put.status === 200);
  check('PUT /quizzes/:id returns new name', json(put.body)?.name === 'Renamed Quiz');

  // Update validation
  const putBad = await req({ path: `/host/api/quizzes/${quizId}`, method: 'PUT', headers: authHeaders() }, { name: '' });
  check('PUT /quizzes/:id empty name → 400', putBad.status === 400);

  return quizId;
}

async function testMCQQuestions(quizId) {
  console.log('\n── MCQ Questions ─────────────────────────────────────────────────');

  // Valid add
  const add = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: 'What is 2+2?', options: ['1','2','3','4'], correctIndex: 3, timeLimitSeconds: 20 }
  );
  check('POST /questions MCQ → 201', add.status === 201);
  const q = json(add.body);
  check('POST /questions returns options array', Array.isArray(q?.options));
  check('POST /questions type defaults to mcq', q?.type === 'mcq');
  const qId = q?.id;

  // Missing text
  const noText = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: '', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 20 }
  );
  check('POST /questions empty text → 400', noText.status === 400);

  // Wrong option count
  const badOpts = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: 'Q?', options: ['a','b','c'], correctIndex: 0, timeLimitSeconds: 20 }
  );
  check('POST /questions 3 options → 400', badOpts.status === 400);

  // bad correctIndex
  const badCI = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: 'Q?', options: ['a','b','c','d'], correctIndex: 4, timeLimitSeconds: 20 }
  );
  check('POST /questions correctIndex=4 → 400', badCI.status === 400);

  // bad timeLimitSeconds
  const badTLS = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: 'Q?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 3 }
  );
  check('POST /questions timeLimitSeconds=3 → 400', badTLS.status === 400);

  // Edit
  const edit = await req(
    { path: `/host/api/questions/${qId}`, method: 'PUT', headers: authHeaders() },
    { text: 'What is 2+3?', correct_index: 2, time_limit_seconds: 30 }
  );
  check('PUT /questions/:id → 200', edit.status === 200);
  check('PUT /questions/:id text updated', json(edit.body)?.text === 'What is 2+3?');

  // Edit empty text
  const editBadText = await req(
    { path: `/host/api/questions/${qId}`, method: 'PUT', headers: authHeaders() },
    { text: '' }
  );
  check('PUT /questions/:id empty text → 400', editBadText.status === 400);

  // Edit bad type
  const editBadType = await req(
    { path: `/host/api/questions/${qId}`, method: 'PUT', headers: authHeaders() },
    { type: 'multiple' }
  );
  check('PUT /questions/:id bad type → 400', editBadType.status === 400);

  return qId;
}

async function testTFQuestions(quizId) {
  console.log('\n── True/False Questions ──────────────────────────────────────────');

  // Valid T/F — correctIndex=0 (True)
  const addTF = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: 'Is the sky blue?', type: 'truefalse', correctIndex: 0, timeLimitSeconds: 15 }
  );
  check('POST /questions T/F → 201', addTF.status === 201);
  const tf = json(addTF.body);
  check('POST /questions T/F type=truefalse', tf?.type === 'truefalse');
  check('POST /questions T/F forces ["True","False"] options', JSON.stringify(tf?.options) === JSON.stringify(['True','False']));
  const tfId = tf?.id;

  // T/F correctIndex=1 (False) — valid
  const addTF1 = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: 'Is water dry?', type: 'truefalse', correctIndex: 1, timeLimitSeconds: 10 }
  );
  check('POST /questions T/F correctIndex=1 → 201', addTF1.status === 201);

  // T/F correctIndex=2 — should be 400
  const addTFBad = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: 'Bad?', type: 'truefalse', correctIndex: 2, timeLimitSeconds: 10 }
  );
  check('POST /questions T/F correctIndex=2 → 400', addTFBad.status === 400, `status=${addTFBad.status}`);

  // Edit T/F — change correct answer
  const editTF = await req(
    { path: `/host/api/questions/${tfId}`, method: 'PUT', headers: authHeaders() },
    { correct_index: 1 }
  );
  check('PUT /questions/:id T/F correct_index=1 → 200', editTF.status === 200);

  return tfId;
}

async function testImageExplanation(quizId) {
  console.log('\n── Image + Explanation Fields ────────────────────────────────────');

  // Add question with imageUrl + explanation
  const add = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    {
      text: 'What color is this?',
      options: ['Red','Blue','Green','Yellow'],
      correctIndex: 0,
      timeLimitSeconds: 20,
      imageUrl: 'https://example.com/image.png',
      explanation: 'Red is the correct color.'
    }
  );
  check('POST /questions with imageUrl + explanation → 201', add.status === 201);
  const q = json(add.body);
  check('POST /questions imageUrl stored', q?.image_url === 'https://example.com/image.png');
  check('POST /questions explanation stored', q?.explanation === 'Red is the correct color.');

  // GET quiz and verify fields round-trip
  const get = await req({ path: `/host/api/quizzes/${quizId}`, method: 'GET', headers: authHeaders() });
  const quiz = json(get.body);
  const imgQ = quiz?.questions?.find(q => q.image_url === 'https://example.com/image.png');
  check('GET /quizzes/:id returns image_url on question', !!imgQ);
  check('GET /quizzes/:id returns explanation on question', imgQ?.explanation === 'Red is the correct color.');

  // Empty imageUrl normalised to null
  const addNoImg = await req(
    { path: `/host/api/quizzes/${quizId}/questions`, method: 'POST', headers: authHeaders() },
    { text: 'Another?', options: ['a','b','c','d'], correctIndex: 0, timeLimitSeconds: 20, imageUrl: '  ' }
  );
  check('POST /questions whitespace imageUrl → null', json(addNoImg.body)?.image_url === null);
}

async function testDuplicate(quizId) {
  console.log('\n── Duplicate Quiz ────────────────────────────────────────────────');

  // Get source quiz question count and check a T/F is present
  const src = json((await req({ path: `/host/api/quizzes/${quizId}`, method: 'GET', headers: authHeaders() })).body);
  const srcCount = src?.questions?.length ?? 0;
  const hasTF = src?.questions?.some(q => q.type === 'truefalse');

  // Duplicate
  const dup = await req({ path: `/host/api/quizzes/${quizId}/duplicate`, method: 'POST', headers: authHeaders() });
  check('POST /quizzes/:id/duplicate → 201', dup.status === 201);
  const newQuiz = json(dup.body);
  check('Duplicate quiz name starts with "Copy of"', newQuiz?.name?.startsWith('Copy of'));
  check(`Duplicate has same question_count (${srcCount})`, newQuiz?.question_count === srcCount, `got ${newQuiz?.question_count}`);

  // Verify T/F question preserved in duplicate
  const dupDetails = json((await req({ path: `/host/api/quizzes/${newQuiz?.id}`, method: 'GET', headers: authHeaders() })).body);
  const dupHasTF = dupDetails?.questions?.some(q => q.type === 'truefalse');
  if (hasTF) {
    check('Duplicate preserves T/F question type', dupHasTF);
  } else {
    check('Duplicate question count matches (no T/F in source to verify)', dupDetails?.questions?.length === srcCount);
  }

  // 404 for unknown quiz
  const dup404 = await req({ path: '/host/api/quizzes/999999/duplicate', method: 'POST', headers: authHeaders() });
  check('POST /quizzes/999999/duplicate → 404', dup404.status === 404);

  return newQuiz?.id;
}

async function testSessionLifecycle(quizId) {
  console.log('\n── Session Lifecycle ─────────────────────────────────────────────');

  // Start with empty quiz (no questions)
  const emptyQuiz = json((await req({ path: '/host/api/quizzes', method: 'POST', headers: authHeaders() }, { name: 'Empty Quiz' })).body);
  const emptyStart = await req(
    { path: '/host/api/session/start', method: 'POST', headers: authHeaders() },
    { quizId: emptyQuiz.id }
  );
  check('POST /session/start empty-quiz → 400', emptyStart.status === 400, `status=${emptyStart.status}`);

  // Start with missing quiz
  const miss = await req(
    { path: '/host/api/session/start', method: 'POST', headers: authHeaders() },
    { quizId: 999999 }
  );
  check('POST /session/start missing quiz → 404', miss.status === 404, `status=${miss.status}`);

  // Missing quizId
  const noId = await req({ path: '/host/api/session/start', method: 'POST', headers: authHeaders() }, {});
  check('POST /session/start no quizId → 400', noId.status === 400);

  // Happy path
  const start = await req(
    { path: '/host/api/session/start', method: 'POST', headers: authHeaders() },
    { quizId }
  );
  check('POST /session/start → 201', start.status === 201, `status=${start.status} body=${start.body.slice(0,120)}`);
  const sess = json(start.body);
  check('POST /session/start returns pin', typeof sess?.pin === 'string' && sess.pin.length > 0);
  check('POST /session/start returns qrDataUrl', typeof sess?.qrDataUrl === 'string' && sess.qrDataUrl.startsWith('data:image'));

  // Validate PIN publicly
  const pinCheck = await req({ path: `/api/session/${sess?.pin}`, method: 'GET' });
  check('GET /api/session/:pin → 200 valid', pinCheck.status === 200 && json(pinCheck.body)?.valid === true);

  // Invalid PIN
  const badPin = await req({ path: '/api/session/XXXXX', method: 'GET' });
  check('GET /api/session/XXXXX → 404', badPin.status === 404);

  // End session so it shows in history
  const endR = await req({ path: '/host/api/session/end', method: 'POST', headers: authHeaders() });
  check('POST /session/end → 200', endR.status === 200);

  // Clean up empty quiz
  await req({ path: `/host/api/quizzes/${emptyQuiz.id}`, method: 'DELETE', headers: authHeaders() });
}

async function testSessionHistory() {
  console.log('\n── Session History ───────────────────────────────────────────────');

  const sessions = await req({ path: '/host/api/sessions', method: 'GET', headers: authHeaders() });
  check('GET /sessions → 200 array', sessions.status === 200 && Array.isArray(json(sessions.body)));

  const list = json(sessions.body);
  if (list && list.length > 0) {
    const first = list[0];
    check('Session history entry has id', typeof first.id === 'number');
    check('Session history entry has status=ended', first.status === 'ended');

    const breakdown = await req({ path: `/host/api/sessions/${first.id}`, method: 'GET', headers: authHeaders() });
    check(`GET /sessions/${first.id} → 200 array`, breakdown.status === 200 && Array.isArray(json(breakdown.body)));
  } else {
    console.log('  SKIP  Session history detail (no ended sessions found)');
  }
}

async function testDeleteCleanup(quizId, dupQuizId) {
  console.log('\n── Cleanup / Delete ──────────────────────────────────────────────');

  // Delete question
  const quiz = json((await req({ path: `/host/api/quizzes/${quizId}`, method: 'GET', headers: authHeaders() })).body);
  if (quiz?.questions?.length) {
    const qId = quiz.questions[0].id;
    const del = await req({ path: `/host/api/questions/${qId}`, method: 'DELETE', headers: authHeaders() });
    check('DELETE /questions/:id → 204', del.status === 204);
    const del404 = await req({ path: `/host/api/questions/${qId}`, method: 'DELETE', headers: authHeaders() });
    check('DELETE /questions/:id again → 404', del404.status === 404);
  }

  // Delete duplicate quiz
  if (dupQuizId) {
    const delDup = await req({ path: `/host/api/quizzes/${dupQuizId}`, method: 'DELETE', headers: authHeaders() });
    check('DELETE /quizzes/:id (duplicate) → 204', delDup.status === 204);
  }

  // Delete main quiz
  const delQ = await req({ path: `/host/api/quizzes/${quizId}`, method: 'DELETE', headers: authHeaders() });
  check('DELETE /quizzes/:id → 204', delQ.status === 204);

  // Delete 404
  const del404 = await req({ path: `/host/api/quizzes/${quizId}`, method: 'DELETE', headers: authHeaders() });
  check('DELETE /quizzes/already-deleted → 404', del404.status === 404);
}

// ── runner ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ROMEU_QUIZ  REST Integration Tests');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    await testHealth();
    await testAuth();
    const quizId = await testQuizCRUD();
    if (!quizId) { console.error('\nCannot continue without a quiz ID — aborting'); process.exit(1); }
    await testMCQQuestions(quizId);
    await testTFQuestions(quizId);
    await testImageExplanation(quizId);
    const dupQuizId = await testDuplicate(quizId);
    await testSessionLifecycle(quizId);
    await testSessionHistory();
    await testDeleteCleanup(quizId, dupQuizId);
  } catch (err) {
    console.error('\nUnhandled error:', err.message);
    failed++;
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})();
