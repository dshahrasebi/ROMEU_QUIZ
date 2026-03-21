# Testing Plan — Gaps & New Coverage

## Current State
- **89 REST tests** in `tests/rest-test.js` — covers health, auth, quiz CRUD, question CRUD, session lifecycle, history
- **71 socket tests** in `tests/socket-test.js` — covers host-join, player-join, answer submission, scoring, streaks, reveal, leaderboard, reconnect, edge cases
- **Test harness**: raw `http` module + `socket.io-client`, no test framework (custom `check()` assertions)
- **Auth pattern**: POST `/host/login` with password, extract session cookie + CSRF token from response cookies
- **CSRF pattern**: always sends valid token — no test verifies rejection of bad/missing tokens

## T1 — CSRF Rejection Tests

### Add to `tests/rest-test.js`

**Test: Missing CSRF token → 403**
```js
async function testCsrfRejection() {
  console.log('\n── CSRF Protection ───────────────────────────────────────────────');

  // POST without CSRF token (but with valid session cookie)
  const noCsrf = await req({
    path: '/host/api/quizzes',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  }, JSON.stringify({ name: 'CSRF Test' }));
  check('POST without CSRF token → 403', noCsrf.status === 403);

  // POST with wrong CSRF token
  const badCsrf = await req({
    path: '/host/api/quizzes',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': 'invalid-token' },
  }, JSON.stringify({ name: 'CSRF Test' }));
  check('POST with wrong CSRF token → 403', badCsrf.status === 403);

  // GET requests should work without CSRF (exempt)
  const getCsrf = await req({
    path: '/host/api/quizzes',
    method: 'GET',
    headers: { Cookie: cookie },
  });
  check('GET without CSRF token → 200 (exempt)', getCsrf.status === 200);

  // Valid CSRF still works (sanity)
  const ok = await req({
    path: '/host/api/quizzes',
    method: 'POST',
    headers: authHeaders(),
  }, JSON.stringify({ name: 'CSRF Sanity Check' }));
  check('POST with valid CSRF → 201', ok.status === 201);
  // Clean up
  const created = json(ok.body);
  if (created?.id) {
    await req({ path: `/host/api/quizzes/${created.id}`, method: 'DELETE', headers: authHeaders() });
  }
}
```

**Call it after `testAuth()` in the main flow.**

### Estimated: 4 new test cases

---

## T2 — Display Screen Socket Tests

### Add to `tests/socket-test.js` or new `tests/display-test.js`

**Tests needed:**

1. **Display join → receives display-state**
   - Connect a socket, emit `display-join` with valid pin
   - Expect `display-state` response with status, players, pin, currentQuestionIndex

2. **Display receives lobby-update when player joins**
   - Display socket in session room
   - Player joins → display receives `lobby-update` with updated player list

3. **Display receives question-start**
   - Host advances → display receives `question-start` with text, options, timeLimitSeconds

4. **Display receives question-reveal**
   - Host reveals → display receives `question-reveal` with correctIndex, answerCounts, explanation

5. **Display receives leaderboard-update**
   - Host advances → display receives `leaderboard-update` with sorted leaderboard

6. **Display receives game-ended**
   - Host ends game → display receives `game-ended` with podium + allPlayers

### Implementation pattern:
```js
// Connect display socket
const displaySocket = io(BASE_URL, { transports: ['websocket'] });
displaySocket.emit('display-join', { pin });
displaySocket.on('display-state', (data) => { ... });
```

### Note: Need to check if `display-join` event exists in socketHandlers.js
- If it doesn't exist yet, the display page might join via a different mechanism
- Need to verify how display/index.html establishes its socket connection

### Estimated: 6-8 new test cases

---

## T3 — Edge Case Tests

### Add to `tests/socket-test.js`

**Test group: Zero players**
1. Start session → advance to first question with 0 players → should work (no crash)
2. Reveal with 0 answers → should show all-zero tally
3. End game with 0 players → should end cleanly

**Test group: Host ends mid-question**
4. Start question → host calls `POST /session/end` while timer running → game ends gracefully
5. All sockets receive `game-ended`
6. Player can't submit after game ended

**Test group: Player joins during reveal/leaderboard**
7. `allow_late_joins: true` → player joins during reveal phase → should work (if late joins on)
8. Joined player appears in next question's lobby-update
9. `allow_late_joins: false` → player joins during question → rejected

**Test group: Duplicate nicknames**
10. Two players try to join with same nickname → second should get `join-error`
11. Player disconnects → different socket tries same nickname → should reconnect (not new join)

**Test group: Session timeout/stale state**
12. Submit answer to a question that's already been revealed → `answer-locked`
13. Submit answer with out-of-range optionIndex → ignored gracefully

### Implementation:
Each test follows the existing pattern:
- Start a fresh session (POST /session/start)
- Connect sockets as needed
- Assert expected events/error responses
- Clean up session (POST /session/end or delete quiz)

### Estimated: 13 new test cases

---

## T4 — Tests for New Batch 1-3 Features

### Each batch should include its own tests:

**Batch 1 tests:**
- Kick player: socket test — host-kick → player receives kicked event, lobby updates
- Streak count: verify streak field in question-reveal payload (already partially tested)

**Batch 2 tests:**
- Question reorder: REST test — PUT /quizzes/:id/reorder with valid/invalid IDs
- Shuffle questions: start 2 sessions with same quiz, shuffle enabled → question order differs (probabilistic — run 5 times)
- Answer tally: socket test — submit answers, verify answer-tally-update emitted with correct counts

**Batch 3 tests:**
- Quiz export: REST test — GET /quizzes/:id/export → valid JSON with formatVersion
- Quiz import: REST test — POST /quizzes/import → creates quiz with correct question count
- CSV export: REST test — GET /sessions/:id/csv → valid CSV with correct headers
- Player results: REST test — GET /api/session/:pin/my-results?nickname=X → correct per-question breakdown

### Estimated per batch: 4-8 new test cases each

---

## Summary

| Category | Tests | Priority |
|---|---|---|
| T1 — CSRF rejection | 4 tests | HIGH — validates existing security |
| T2 — Display socket | 6-8 tests | MEDIUM — untested client type |
| T3 — Edge cases | 13 tests | MEDIUM — boundary conditions |
| T4 — Feature tests | 4-8 per batch | WITH each batch |

**Total current**: 160 tests (89 REST + 71 socket)
**After all testing work**: ~200+ tests
