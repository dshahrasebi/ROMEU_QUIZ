const http = require('http');

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  // 1. Login
  const login = await req({
    hostname: 'localhost', port: 3000,
    path: '/host/login', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, 'password=changeme');
  const cookie = login.headers['set-cookie']?.[0]?.split(';')[0];
  console.log('1. Login →', login.status, login.headers.location);

  // 2. Create quiz
  const quiz = await req({
    hostname: 'localhost', port: 3000,
    path: '/host/api/quizzes', method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }
  }, JSON.stringify({ name: 'Smoke Test' }));
  const quizData = JSON.parse(quiz.body);
  console.log('2. Create quiz →', quiz.status, quizData);

  // 3. Add question
  const q = await req({
    hostname: 'localhost', port: 3000,
    path: '/host/api/quizzes/' + quizData.id + '/questions', method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }
  }, JSON.stringify({ text: 'What is 1+1?', options: ['1','2','3','4'], correctIndex: 1, timeLimitSeconds: 20 }));
  console.log('3. Add question →', q.status, q.body.slice(0, 80));

  // 4. Start session
  const sess = await req({
    hostname: 'localhost', port: 3000,
    path: '/host/api/session/start', method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }
  }, JSON.stringify({ quizId: quizData.id }));
  const sessData = JSON.parse(sess.body);
  console.log('4. Start session →', sess.status, 'PIN:', sessData.pin, 'QR present:', !!sessData.qrDataUrl);

  // 5. Validate session publicly
  const check = await req({
    hostname: 'localhost', port: 3000,
    path: '/api/session/' + sessData.pin, method: 'GET'
  });
  console.log('5. Validate PIN →', check.status, check.body);

  console.log('\n✅ All checks passed!');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
