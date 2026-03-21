# Batch 3 — Data Export + Polish

## 3.1 Quiz Import/Export (JSON)

### Problem
No way to back up quizzes, share them between instances, or migrate to a new deployment.

### Current architecture
- `getQuizById` returns: `{ id, name, created_at, questions: [{ id, quiz_id, text, options, correct_index, time_limit_seconds, sort_order, type, image_url, explanation }] }`
- `createQuiz(name)` creates empty quiz, returns `{ id, name, created_at }`
- `addQuestion(quizId, text, options, correctIndex, timeLimitSeconds, type, imageUrl, explanation)` adds one question

### Implementation

**Step 1 — Add GET `/host/api/quizzes/:id/export` endpoint**
- In `server.js`, after the quiz CRUD routes:
  ```js
  app.get('/host/api/quizzes/:id/export', requireHost, (req, res) => {
    const quiz = db.getQuizById(Number(req.params.id));
    if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });
    const exportData = {
      formatVersion: 1,
      name: quiz.name,
      questions: quiz.questions.map(q => ({
        text: q.text,
        options: q.options,
        correctIndex: q.correct_index,
        timeLimitSeconds: q.time_limit_seconds,
        type: q.type || 'mcq',
        imageUrl: q.image_url || null,
        explanation: q.explanation || null,
      })),
    };
    res.setHeader('Content-Disposition', `attachment; filename="${quiz.name.replace(/[^a-zA-Z0-9]/g, '_')}.json"`);
    res.json(exportData);
  });
  ```

**Step 2 — Add POST `/host/api/quizzes/import` endpoint**
- ```js
  app.post('/host/api/quizzes/import', requireHost, (req, res) => {
    const { name, questions } = req.body;
    if (!name || !Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: 'Invalid import format' });
    }
    const quiz = db.createQuiz(name);
    for (const q of questions) {
      // Validate each question minimally
      if (!q.text || !Array.isArray(q.options)) continue;
      db.addQuestion(
        quiz.id, q.text, q.options,
        q.correctIndex ?? 0, q.timeLimitSeconds ?? 20,
        q.type || 'mcq', q.imageUrl || null, q.explanation || null
      );
    }
    const full = db.getQuizById(quiz.id);
    return res.status(201).json({ ...full, question_count: full.questions.length });
  });
  ```

**Step 3 — Add Export/Import buttons to host UI**
- Export: add a download button (📥) on each quiz card in `renderQuizList`
  - On click: `window.location = '/host/api/quizzes/' + quizId + '/export'`
- Import: add an "Import Quiz" button next to "New Quiz" in the library header
  - Opens a file picker for .json files
  - Reads the file with FileReader, parses JSON, POSTs to `/host/api/quizzes/import`
  - On success, reloads quiz list

**Step 4 — Add i18n keys**
- `host.btn_export`, `host.btn_import`, `host.import_success`, `host.import_error`

### Files modified
- `server.js` — 2 new endpoints (~35 lines)
- `public/host/index.html` — export button per card + import button + file picker handler (~40 lines)
- `public/i18n.js` — 4 keys × 2 languages

### Verification
1. Export a quiz → downloads a .json file with correct structure
2. Import that .json file → new quiz created with all questions intact
3. Import with missing fields → graceful error
4. Exported quiz plays identically to original

---

## 3.2 CSV Export of Session Results

### Problem
Teachers and trainers need spreadsheet-friendly results. Currently, history only shows aggregate bar charts in the UI.

### Current data
- `getCompletedSessions()` returns: id, pin, started_at, ended_at, quiz_name, player_count, winner_nickname, winner_score
- `getSessionAnswerBreakdown(sessionId)` returns: per-question tally (aggregated counts, NOT per-player)
- Missing: per-player per-question answers → need new DB query

### Implementation

**Step 1 — Add `getSessionPlayerResults(sessionId)` to db.js**
  ```js
  const getSessionPlayerResults = (sessionId) => {
    return db.prepare(`
      SELECT p.nickname, p.score,
        a.question_id, a.option_index, a.elapsed_ms, a.points_earned,
        q.text AS question_text, q.correct_index
      FROM players p
      LEFT JOIN answer_submissions a ON a.player_id = p.id AND a.session_id = p.session_id
      LEFT JOIN questions q ON q.id = a.question_id
      WHERE p.session_id = ?
      ORDER BY p.score DESC, p.nickname, q.sort_order ASC
    `).all(sessionId);
  };
  ```

**Step 2 — Add GET `/host/api/sessions/:id/csv` endpoint**
  ```js
  app.get('/host/api/sessions/:id/csv', requireHost, (req, res) => {
    const sessionId = Number(req.params.id);
    const rows = db.getSessionPlayerResults(sessionId);
    if (!rows.length) return res.status(404).json({ error: 'No data' });

    // Build CSV: Nickname, Total Score, Q1 Answer, Q1 Correct, Q1 Points, Q2...
    // Group by player, then by question
    const players = {};
    const questions = [];
    const questionSet = new Set();
    for (const r of rows) {
      if (!players[r.nickname]) players[r.nickname] = { score: r.score, answers: {} };
      if (r.question_id && !questionSet.has(r.question_id)) {
        questionSet.add(r.question_id);
        questions.push({ id: r.question_id, text: r.question_text, correctIndex: r.correct_index });
      }
      if (r.question_id) {
        players[r.nickname].answers[r.question_id] = {
          optionIndex: r.option_index,
          correct: r.option_index === r.correct_index,
          points: r.points_earned,
          elapsed: r.elapsed_ms,
        };
      }
    }

    // CSV header
    let csv = 'Nickname,Total Score';
    for (const q of questions) csv += `,"${q.text.replace(/"/g, '""')} (Answer)","${q.text.replace(/"/g, '""')} (Correct)","${q.text.replace(/"/g, '""')} (Points)"`;
    csv += '\n';

    // CSV rows
    for (const [nick, data] of Object.entries(players)) {
      csv += `"${nick}",${data.score}`;
      for (const q of questions) {
        const a = data.answers[q.id];
        csv += `,${a ? a.optionIndex : ''},${a ? a.correct : ''},${a ? a.points : 0}`;
      }
      csv += '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="session-${sessionId}.csv"`);
    res.send(csv);
  });
  ```

**Step 3 — Add "Download CSV" button to session history detail**
- In `public/host/index.html`, `toggleSessionDetail` function (~line 1219):
  - Add a download button above the per-question breakdown:
    ```html
    <button onclick="window.location='/host/api/sessions/${sessionId}/csv'"
      class="...">📊 Download CSV</button>
    ```

**Step 4 — Add i18n keys**
- `host.btn_download_csv`

### Files modified
- `src/db.js` — new query function + export (~12 lines)
- `server.js` — new CSV endpoint (~40 lines)
- `public/host/index.html` — download button (~5 lines)
- `public/i18n.js` — 1 key × 2 languages

### Verification
1. Complete a game session
2. Go to History → click Details → click Download CSV
3. Open CSV in Excel/Sheets → player names, scores, per-question answers visible
4. Test with session that has no submissions → graceful 404

---

## 3.3 Post-Game Personal Breakdown on Player Phone

### Problem
At game end, player sees only final score + rank. No per-question breakdown — can't learn what they got wrong.

### Current architecture
- `game-ended` payload: `{ podium, allPlayers: [{nickname, score, rank}], archived }`
- `allPlayers` comes from `gameManager.endSession()` which returns sorted players with rank
- Per-question data is in `answer_submissions` table but not included in the ended payload
- Player ended screen HTML (`play/index.html` line 230) only shows score + rank

### Implementation

**Step 1 — Include per-player question summary in game-ended payload**
- In `src/gameManager.js` `endSession()` function:
  - After computing the leaderboard, for each player, collect their answers from `state.answers` (Map of playerId → answer objects per question)
  - Actually, `state.answers` is reset per question. Need a different approach.
  - Better: query `answer_submissions` from DB since they're persisted on each submit
  - Add to the `allPlayers` array: `questionResults: [{questionText, correct, pointsEarned}]`
  
  Alternative (simpler): Instead of bloating the game-ended payload for ALL players, let the player page fetch their own breakdown via a REST endpoint.

**Step 2 — Add GET `/api/session/:pin/my-results?nickname=X` endpoint**
- No auth required (players aren't authenticated), but scoped by pin + nickname
  ```js
  app.get('/api/session/:pin/my-results', (req, res) => {
    const session = db.getSessionByPin(req.params.pin);
    if (!session || session.status !== 'ended') return res.status(404).json({ error: 'Session not found' });
    const nickname = (req.query.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'nickname required' });
    const results = db.getPlayerResults(session.id, nickname);
    return res.json(results);
  });
  ```

**Step 3 — Add `getPlayerResults(sessionId, nickname)` to db.js**
  ```js
  const getPlayerResults = (sessionId, nickname) => {
    const player = db.prepare(
      'SELECT id, score FROM players WHERE session_id = ? AND nickname = ?'
    ).get(sessionId, nickname);
    if (!player) return null;
    const answers = db.prepare(`
      SELECT q.text, q.options, q.correct_index, a.option_index, a.points_earned
      FROM answer_submissions a
      JOIN questions q ON q.id = a.question_id
      WHERE a.session_id = ? AND a.player_id = ?
      ORDER BY q.sort_order ASC
    `).all(sessionId, player.id);
    return {
      nickname, score: player.score,
      questions: answers.map(a => ({
        text: a.text,
        yourAnswer: JSON.parse(a.options)[a.option_index],
        correctAnswer: JSON.parse(a.options)[a.correct_index],
        correct: a.option_index === a.correct_index,
        points: a.points_earned,
      })),
    };
  };
  ```

**Step 4 — Update player ended screen**
- In `public/play/index.html`, after showing `screen-ended`:
  - Fetch `/api/session/${pin}/my-results?nickname=${savedNickname}`
  - Render a scrollable list: "Q1: ✓ +850pts", "Q2: ✗ Correct was: Paris", etc.
  - Add to `#screen-ended` HTML: `<div id="ended-breakdown" class="mt-4 space-y-2 max-h-64 overflow-y-auto"></div>`

### Files modified
- `src/db.js` — new `getPlayerResults` function + export (~15 lines)
- `server.js` — new REST endpoint (~10 lines)
- `public/play/index.html` — fetch + render breakdown in ended screen (~30 lines)
- `public/i18n.js` — ~4 keys × 2 languages (correct, wrong, your_answer, correct_answer)

### Verification
1. Complete a game, check ended screen shows per-question breakdown
2. Wrong answers show what the correct answer was
3. Points per question shown
4. Works in both EN and ES
5. Refresh ended screen → data still available (DB-backed, not ephemeral)

---

## 3.4 Host Panel Mobile Responsiveness

### Problem
Host panel uses hardcoded `grid-cols-3` and `grid-cols-2` layouts that break on small screens. The game control panel is especially bad — it's a 3-column grid at `h-screen`.

### Key layout issues
- `#panel-game` (line 446): `grid grid-cols-3 gap-6 h-screen` — 3 columns, fixed viewport height
- Settings grids (lines 164, 176, 226): `grid-cols-2` with no responsive breakpoints
- Question form (line 982): `grid grid-cols-2` for answer options
- No `sm:` or `md:` Tailwind breakpoints used anywhere in host page

### Implementation

**Step 1 — Fix game panel layout**
- Change `grid grid-cols-3` → `grid grid-cols-1 md:grid-cols-3`
- Change `h-screen` → `min-h-screen` (allow scrolling on mobile)
- Left sidebar (`col-span-1`): on mobile, show as a collapsible player list at top
- Center stage (`col-span-2`): on mobile, full width below

**Step 2 — Fix settings grids**
- Change all `grid-cols-2` in settings panels to `grid grid-cols-1 sm:grid-cols-2`
- This stacks inputs on narrow screens

**Step 3 — Fix quiz card layouts**
- Quiz card buttons row: add `flex-wrap` if not present
- Question form tile grid: `grid-cols-1 sm:grid-cols-2`

**Step 4 — Fix settings tab bar scrolling**
- Tab bar (line 112): 7 tabs in a `flex` row — overflows on mobile
- Add `overflow-x-auto` and `flex-shrink-0` to make it horizontally scrollable
- Or: stack tabs into 2 rows on mobile with `flex-wrap`

**Step 5 — Test common breakpoints**
- 375px (iPhone SE), 390px (iPhone 14), 768px (iPad), 1024px (desktop)

### Files modified
- `public/host/index.html` — ~15-20 class changes across layout divs (no JS changes)

### Verification
1. Open host panel on iPhone-sized viewport (Chrome DevTools device mode)
2. All panels scrollable and readable
3. Game control panel usable — can see player list, advance questions
4. Settings tabs accessible without horizontal overflow
5. Desktop layout unchanged

---

## 3.5 Toast/Snackbar Notification System

### Problem
Many host actions produce no visible feedback: saving settings, copying PIN, deleting a quiz. Some use `alert()` which is blocking and ugly.

### Current state
- `alert()` used for: duplicate error, some confirmations
- Password change has inline `#settings-pw-msg` div (line 307)
- No shared notification pattern exists

### Implementation

**Step 1 — Create a minimal toast system**
- Add a fixed-position toast container at the bottom of `host/index.html`:
  ```html
  <div id="toast-container" class="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none"></div>
  ```
- Add a `showToast(message, type='success')` JS function:
  ```js
  function showToast(msg, type = 'success') {
    const colors = { success: 'bg-green-600', error: 'bg-red-600', info: 'bg-blue-600' };
    const el = document.createElement('div');
    el.className = `${colors[type] || colors.info} text-white font-bold px-4 py-3 rounded-xl shadow-lg text-sm pointer-events-auto`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
  }
  ```

**Step 2 — Replace alert() calls with showToast()**
- Settings save success → `showToast(t('host.settings_saved'), 'success')`
- Quiz delete → `showToast(t('host.quiz_deleted'))`
- Quiz duplicate → `showToast(t('host.quiz_duplicated'))`
- Errors → `showToast(errorMessage, 'error')`

**Step 3 — Add "Copy PIN" toast**
- In game panel lobby, after copying PIN to clipboard: `showToast(t('host.pin_copied'))`

**Step 4 — Add i18n keys**
- `host.settings_saved`, `host.quiz_deleted`, `host.quiz_duplicated`, `host.pin_copied`, etc.

### Files modified
- `public/host/index.html` — toast container HTML + `showToast` function + replace alert() calls (~30 lines)
- `public/i18n.js` — ~6 keys × 2 languages

### Verification
1. Save settings → green toast appears bottom-right, auto-dismisses
2. Delete quiz → toast confirms deletion
3. Error scenario → red toast with error message
4. Multiple toasts stack vertically
5. Toasts don't block interaction
