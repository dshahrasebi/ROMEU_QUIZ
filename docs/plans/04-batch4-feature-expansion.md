# Batch 4 — Feature Expansion

## 4.1 Poll Question Type (No Correct Answer)

### Problem
No way to run icebreaker/opinion polls. MCQ and True/False both require a correct answer.

### Current architecture
- Question creation (server.js line 506): `type === 'truefalse' ? 'truefalse' : 'mcq'` — unknown types fallback to mcq
- DB schema (db.js line 26): `correct_index NOT NULL CHECK(correct_index BETWEEN 0 AND 3)` — cannot represent "no correct"
- Scoring (gameManager.js line 205): `isCorrect = optionIndex === question.correct_index` — always scores
- Reveal (gameManager.js line 380): emits `correctIndex` in payload — display highlights correct tile
- Update validation (server.js line 573): explicitly allows only 'mcq' and 'truefalse'

### Implementation

**Step 1 — DB schema migration**
- Alter `correct_index` to allow -1 for polls:
  ```sql
  -- Can't alter CHECK constraint in SQLite; need to handle in app logic
  ```
- Actually: SQLite CHECK constraints can't be altered. Two options:
  - A) Remove the CHECK and validate in app code (requires recreating the table — complex migration)
  - B) Use `correct_index = -1` convention and adjust the CHECK to `BETWEEN -1 AND 3`
- Best approach: Add migration in db.js that recreates the questions table with the relaxed CHECK. Use a transaction to copy data.

**Step 2 — Server validation**
- In question creation (server.js): add `'poll'` as valid type
- For poll type: `correct_index` should be -1, options can be 2-4 items (flexible)
- Skip correct_index validation for polls

**Step 3 — Scoring**
- In gameManager.js `submitAnswer`: if `question.type === 'poll'`, award flat participation points (e.g., 100) or 0 points
- No streak impact for polls
- All submissions are "correct" (or rather, "not scored")

**Step 4 — Reveal**
- In gameManager.js `revealAnswer`: for polls, emit `correctIndex: null` and `isPoll: true`
- Display screen: show only the distribution bars, no ✓ marker
- Player phone: show "Thanks for voting!" instead of correct/wrong

**Step 5 — Host question form**
- Add 'Poll' option to the type dropdown in `_questionFormHTML`
- When poll is selected: hide the "Correct Answer" selector
- Allow 2-4 answer options (remove the "exactly 4" requirement)

**Step 6 — i18n**
- `host.qf_poll`, `play.poll_thanks`, `host.qf_poll_note`, display poll label

### Files modified
- `src/db.js` — schema migration for CHECK constraint (~20 lines)
- `server.js` — question validation changes (~15 lines)
- `src/gameManager.js` — poll scoring branch (~10 lines), reveal changes (~5 lines)
- `public/host/index.html` — question form poll option + hide correct selector (~15 lines)
- `public/display/index.html` — poll reveal rendering (~10 lines)
- `public/play/index.html` — poll feedback screen (~5 lines)
- `public/i18n.js` — ~4 keys × 2 languages
- `src/i18n-server.js` — update type error message

### Verification
1. Create a poll question with 3 options → saves correctly
2. Start game → poll question shows, no "correct" indicator on players
3. All players who answer get participation points (or 0)
4. Reveal shows distribution only, no ✓
5. Non-poll questions still work exactly as before
6. Edit poll ↔ MCQ type conversion works

---

## 4.2 Solo Practice Mode

### Problem
No way to study/practice a quiz alone. Requires a host session + display.

### Architecture approach
- Create a standalone `/practice` page that loads a quiz and self-paces through questions
- No WebSocket needed — purely client-side with REST API calls
- No session/PIN — just pick a quiz from a public list

### Implementation

**Step 1 — Add public quiz list endpoint**
  ```js
  app.get('/api/quizzes/public', (_req, res) => {
    const quizzes = db.getAllQuizzes().filter(q => q.question_count > 0);
    res.json(quizzes.map(q => ({ id: q.id, name: q.name, questionCount: q.question_count })));
  });
  ```

**Step 2 — Add public quiz detail endpoint (no auth)**
  ```js
  app.get('/api/quizzes/:id/practice', (_req, res) => {
    const quiz = db.getQuizById(Number(req.params.id));
    if (!quiz || !quiz.questions.length) return res.status(404).json({ error: 'Not found' });
    // Shuffle questions optionally, strip correct_index from payload
    const questions = quiz.questions.map(q => ({
      id: q.id, text: q.text, options: q.options,
      timeLimitSeconds: q.time_limit_seconds, type: q.type,
      imageUrl: q.image_url, explanation: q.explanation,
      // correct_index sent but checked client-side after answer
      correctIndex: q.correct_index,
    }));
    res.json({ name: quiz.name, questions });
  });
  ```

  Note: this exposes correct answers in the payload — acceptable for practice mode since it's for self-study. If cheating is a concern, add a setting to enable/disable practice mode.

**Step 3 — Create `public/practice/index.html`**
- Quiz picker screen: fetch `/api/quizzes/public`, render clickable list
- Question screen: show one question at a time, 4 tiles, countdown timer
- On tap: immediately show correct/wrong + explanation (no server round-trip)
- Track score client-side, show running total
- End screen: final score + per-question breakdown
- No login required

**Step 4 — Add practice mode toggle in settings**
- `enable_practice_mode: 'true'` default in SETTING_DEFAULTS
- Guard the `/api/quizzes/public` and `/practice` endpoints with this check
- Setting accessible in host Settings → General tab

**Step 5 — Static route**
- `app.use('/practice', express.static(path.join(__dirname, 'public/practice'), staticOpts));`

### Files modified
- `server.js` — 2 new endpoints + static route (~25 lines)
- `src/db.js` — 1 new setting default
- `public/practice/index.html` — new file (~300 lines, self-contained)
- `public/i18n.js` — ~10 practice-mode keys × 2 languages
- `public/host/index.html` — practice mode setting checkbox

### Verification
1. Navigate to `/practice` → see list of quizzes
2. Pick a quiz → plays through questions self-paced
3. Correct/wrong shown immediately with explanation
4. End screen shows breakdown
5. Disable practice mode in settings → `/practice` returns 403/empty

---

## 4.3 Pause/Unpause Mid-Game

### Problem
No way to freeze the timer if there's a disruption (projector issue, fire alarm, etc.).

### Current architecture
- Game statuses: `lobby`, `question`, `reveal`, `leaderboard`, `ended`
- Two separate timer domains:
  - `revealTimer` in gameManager.js (line 20): question auto-reveal
  - `_autoAdvanceTimer` + `_leaderboardTimer` in socketHandlers.js (line 10-11): reveal→leaderboard, leaderboard→next
- `clearAutoTimers()` in socketHandlers.js clears advance/leaderboard timers but NOT the question timer
- `_clearRevealTimer()` in gameManager.js clears the question timer

### Implementation

**Step 1 — Add `paused` status to game state**
- In gameManager.js, add `paused` to valid statuses
- Add fields to state: `pausedAt`, `pausedStatus` (to know what to resume to), `remainingMs`
- Pause function:
  ```js
  function pauseGame() {
    if (!state || state.status === 'lobby' || state.status === 'ended' || state.status === 'paused') return null;
    state.pausedStatus = state.status;
    state.pausedAt = Date.now();
    // Calculate remaining time if in question phase
    if (state.status === 'question') {
      const elapsed = Date.now() - state.questionOpenAt;
      const total = state.questions[state.currentQuestionIndex].time_limit_seconds * 1000;
      state.remainingMs = Math.max(0, total - elapsed);
    }
    state.status = 'paused';
    _clearRevealTimer();
    return { pausedStatus: state.pausedStatus, remainingMs: state.remainingMs };
  }
  ```
- Resume function:
  ```js
  function resumeGame() {
    if (!state || state.status !== 'paused') return null;
    state.status = state.pausedStatus;
    if (state.status === 'question' && state.remainingMs > 0) {
      state.questionOpenAt = Date.now() - (state.questions[state.currentQuestionIndex].time_limit_seconds * 1000 - state.remainingMs);
    }
    return { status: state.status, remainingMs: state.remainingMs };
  }
  ```

**Step 2 — Add socket events**
- `host-pause` → calls `pauseGame()` + `clearAutoTimers()`, emits `game-paused` to session room
- `host-resume` → calls `resumeGame()`, re-schedules auto-reveal with remaining time, emits `game-resumed` to session room

**Step 3 — UI updates**
- Host panel: add Pause/Resume button (toggles based on paused state)
- Display screen: show "PAUSED" overlay when `game-paused` received, remove on `game-resumed`
- Player page: show "Game paused" message, disable tile interaction
- Timer resumes from where it left off (send `remainingMs` in resume payload)

**Step 4 — REST API pause/resume** (mirror socket for consistency)
- POST `/host/api/session/pause` and `/host/api/session/resume`

### Files modified
- `src/gameManager.js` — pause/resume functions + state fields (~40 lines)
- `src/socketHandlers.js` — 2 new socket events + REST handlers (~30 lines)
- `server.js` — 2 new REST endpoints (~15 lines)
- `public/host/index.html` — pause/resume button (~10 lines)
- `public/display/index.html` — paused overlay + listener (~15 lines)
- `public/play/index.html` — paused state + listener (~10 lines)

### Verification
1. Start game, begin a question, click Pause → timer freezes on all screens
2. Display shows "PAUSED" overlay
3. Players can't submit answers while paused
4. Resume → timer continues from remaining time, not restarted
5. Auto-advance timers also resume correctly

---

## 4.4 Question Bank / Folders / Tags

### Problem
With 20+ quizzes, finding the right one becomes painful. No organization structure.

### Implementation

**Step 1 — Add folders (lightweight approach)**
- Add `folder` TEXT column to quizzes table (nullable, default null = root)
- Migration: `ALTER TABLE quizzes ADD COLUMN folder TEXT`
- No separate folders table — just string-matching (flat list of folder names)

**Step 2 — API changes**
- `GET /host/api/quizzes` — include `folder` field in response
- `PUT /host/api/quizzes/:id` — accept `folder` in body to move quiz to a folder
- `GET /host/api/quizzes?folder=X` — optional filter

**Step 3 — UI changes**
- Quiz list: group by folder, show folder headers with collapse
- "Move to folder" action on each quiz card (dropdown or modal)
- "New Folder" button in library header
- Search/filter input at top of quiz list

**Step 4 — Tags (phase 2, simpler than folders)**
- Alternatively, skip folders and just add a search bar with instant filtering by quiz name
- This solves 80% of the organization problem with 10% of the effort

### Recommended: Start with just a search/filter bar, defer full folders to later

### Files modified (search only)
- `public/host/index.html` — search input + filter logic (~20 lines)
- `public/i18n.js` — 1-2 keys

### Verification
1. Type in search bar → quiz list filters in real time
2. Clear search → all quizzes shown
3. No quizzes match → "No results" message

---

## 4.5 Emoji Reactions from Players

### Problem
Games feel static — no way for players to react to questions or results.

### Implementation

**Step 1 — Add `player-react` socket event**
- Player emits: `{ emoji: '🔥' }` (from a fixed set of 4-6 emojis)
- Server validates emoji is in allowed set, rate-limits (max 1 per 2 seconds per player)
- Server broadcasts to `session:{pin}`: `player-reacted: { emoji, nickname }`

**Step 2 — Display screen reaction rendering**
- Floating emoji animation: emoji appears at random x-position, floats up, fades out
- CSS animation, no library needed

**Step 3 — Player UI**
- Small emoji bar at bottom of question screen and feedback screen
- 4-6 preset emojis: 🔥 👏 😱 😂 🎉 💀
- Tap to send, brief cooldown indicator

### Files modified
- `src/socketHandlers.js` — new event handler with rate limit (~15 lines)
- `public/play/index.html` — emoji bar + send logic (~20 lines)
- `public/display/index.html` — floating reaction renderer (~30 lines)
- CSS animation in shared.css or inline (~10 lines)

### Verification
1. Player taps 🔥 → emoji floats up on display screen
2. Rate limit: rapid taps only send first one
3. Multiple players' emojis appear simultaneously
4. Emojis don't interfere with question/timer UI

---

## 4.6 Bulk Import via CSV/Paste

### Problem
Creating a 30-question quiz manually is tedious. Power users want to paste from a spreadsheet.

### Implementation

**Step 1 — Add "Bulk Import" option to quiz creation**
- Button next to "Add Question" that opens a textarea
- Expected CSV format: `Question text, Option A, Option B, Option C, Option D, Correct Index (0-3), Time (seconds)`
- Paste from Google Sheets / Excel (tab-separated) or CSV

**Step 2 — Parse and validate in client JS**
- Split by newlines, then by tab or comma
- Validate: at least question text + 4 options + correct index
- Show preview table with green/red row indicators
- "Import All" button → POSTs each question to existing add-question endpoint

**Step 3 — Alternative: file upload**
- Accept .csv file upload alongside paste

### Files modified
- `public/host/index.html` — bulk import modal/panel + parser (~80 lines)
- `public/i18n.js` — ~5 keys × 2 languages

### Verification
1. Paste 5 tab-separated rows → preview shows 5 questions
2. Import → all 5 added to quiz with correct options/correct index
3. Invalid rows highlighted in red, skipped on import
4. Empty rows/trailing whitespace handled gracefully
