# Batch 2 — Authoring + Game Quality

## 2.1 Drag-and-Drop Question Reorder

### Problem
Questions can only be added in sequence. There is no way to change the order after creation without deleting and recreating. The `sort_order` column exists but has no update path.

### Current architecture
- `sort_order` column in `questions` table, set to `max+1` on insert (`db.js` line 114)
- Questions fetched with `ORDER BY sort_order ASC, id ASC` (`db.js` line 101)
- `updateQuestion` allowed fields list (`db.js` line 126) does NOT include `sort_order`
- Question rows rendered with sequential numbering in `renderQuestions` (`host/index.html` line 916)
- No drag handles, no move buttons in the HTML

### Implementation

**Step 1 — Add PUT `/host/api/quizzes/:id/reorder` endpoint in server.js**
- After the duplicate endpoint (~line 490), add:
  ```js
  app.put('/host/api/quizzes/:id/reorder', requireHost, (req, res) => {
    const quizId = Number(req.params.id);
    const quiz = db.getQuizById(quizId);
    if (!quiz) return res.status(404).json({ error: t('err.quiz.not_found') });
    const { questionIds } = req.body;
    if (!Array.isArray(questionIds)) return res.status(400).json({ error: 'questionIds array required' });
    // Validate all IDs belong to this quiz
    const existing = new Set(quiz.questions.map(q => q.id));
    if (questionIds.length !== existing.size || !questionIds.every(id => existing.has(id))) {
      return res.status(400).json({ error: 'questionIds must contain all question IDs for this quiz' });
    }
    db.reorderQuestions(quizId, questionIds);
    return res.json({ ok: true });
  });
  ```

**Step 2 — Add `reorderQuestions` helper in db.js**
- ```js
  const reorderQuestions = (quizId, orderedIds) => {
    const update = db.prepare('UPDATE questions SET sort_order = ? WHERE id = ? AND quiz_id = ?');
    db.transaction(() => {
      orderedIds.forEach((id, index) => update.run(index, id, quizId));
    })();
  };
  ```
- Export it from the module

**Step 3 — Add drag-and-drop to question list in host/index.html**
- Use the native HTML5 Drag and Drop API (no external library needed for a simple list)
- In `renderQuestions` (line 916), add to each question row div:
  - `draggable="true"` attribute
  - `data-question-id="${q.id}"` attribute
  - A drag handle element: `<span class="cursor-grab text-white/30 hover:text-white mr-2">⠿</span>`
- Add event listeners for `dragstart`, `dragover`, `dragend`, `drop` on the question-list container
- On `drop`, collect the new order of `data-question-id` values and call:
  ```js
  await apiFetch(`/host/api/quizzes/${quizId}/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionIds: newOrder })
  });
  ```
- Re-render question numbers after reorder

**Step 4 — Mobile fallback: up/down buttons**
- Since drag-and-drop is poor on touch devices, add small ▲/▼ buttons next to the drag handle
- On click, swap the question with its neighbor and call the reorder API

### Files modified
- `server.js` — new PUT endpoint (~15 lines)
- `src/db.js` — new `reorderQuestions` function + export (~8 lines)
- `public/host/index.html` — drag-drop logic + up/down buttons in `renderQuestions` (~60 lines)

### Verification
1. Create quiz with 3+ questions
2. Drag question 3 to position 1 → numbers update, order persists after page reload
3. Use up/down buttons → same result
4. Start a game → questions appear in the reordered sequence
5. Add new REST test: PUT reorder with valid/invalid IDs

---

## 2.2 Live Answer Count During Question Phase

### Problem
During a question, neither the display screen nor the audience can see how many players have answered. The host panel already receives `answer-tally-update` events, but the display screen doesn't.

### Current architecture
- `submit-answer` handler (socketHandlers.js line 289) already emits `answer-tally-update` to `host:{pin}` room
- Payload includes: `{ tally, totalAnswered, totalPlayers, answeredNicknames }`
- Display screen listens to `session:{pin}` room but NOT `host:{pin}` room
- Display `question-start` rendering has no answer count element

### Implementation

**Step 1 — Emit answer count to display screen too**
- In socketHandlers.js `submit-answer` handler (line 306), change the emit target:
  - Currently: `io.to('host:${pin}').emit('answer-tally-update', ...)`
  - Change to: `io.to('session:${pin}').emit('answer-tally-update', ...)`
  - This broadcasts to host, display, AND all players
  - The `answeredNicknames` field should be REMOVED from the broadcast (privacy: other players shouldn't see who answered)
  - Instead, emit `answeredNicknames` only to `host:{pin}` in a separate event or keep it in the shared one (host can use it, players/display ignore it)

  Better approach: emit to `session:{pin}` with `{ totalAnswered, totalPlayers }` only, and separately emit the detailed tally+nicknames to `host:{pin}`

**Step 2 — Add progress indicator to display question rendering**
- In `public/display/index.html`, question render function (~line 212):
  - Add a `<div id="answer-progress">` element showing "0 / 12 answered" in the header area
- Add socket listener:
  ```js
  socket.on('answer-tally-update', (data) => {
    const el = document.getElementById('answer-progress');
    if (el) el.textContent = `${data.totalAnswered} / ${data.totalPlayers}`;
  });
  ```
- Reset on `question-start`

**Step 3 — Optionally show on player phone too**
- In `public/play/index.html`, add a small "12/20 answered" indicator below the locked tiles
- Only update when `answer-tally-update` is received and tiles are already locked

### Files modified
- `src/socketHandlers.js` — split tally emit into session-wide (count) and host-only (detailed) (~5 lines changed)
- `public/display/index.html` — progress element + socket listener (~15 lines)
- `public/play/index.html` — optional progress text (~10 lines)

### Verification
1. Start game with 3+ players
2. Display screen shows "0/3" during question
3. As players answer, count increments in real-time
4. Host panel still shows detailed tally + nicknames
5. Players see count after they've answered (optional)

---

## 2.3 Randomize Question Order Per Session

### Problem
Running the same quiz twice is predictable. Back-row players can share answers for upcoming questions.

### Current architecture
- `gameManager.js` line 108: `questions: quiz.questions` — direct reference, same order every time
- Questions come from DB ordered by `sort_order ASC, id ASC`
- No shuffle setting exists

### Implementation

**Step 1 — Add `shuffle_questions` setting**
- `src/db.js` SETTING_DEFAULTS: add `shuffle_questions: 'false'`
- `server.js` SETTING_RULES: add `shuffle_questions: { type: 'bool' }`
- Expose in public settings (so display/player can optionally show "Randomized" badge)

**Step 2 — Add Settings UI toggle**
- In `public/host/index.html`, Settings → Game tab (`stab-panel-game`):
  - Add checkbox: "Shuffle question order each session"
  - Wire to `s-shuffle_questions` in load/save logic

**Step 3 — Shuffle in gameManager.startSession**
- In `src/gameManager.js` startSession (~line 108), after loading quiz:
  ```js
  let questions = [...quiz.questions]; // shallow copy
  if (settings.shuffleQuestions) {
    // Fisher-Yates shuffle
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
  }
  state.questions = questions;
  ```

**Step 4 — Add i18n keys**
- `host.shuffle_questions_label`, `host.shuffle_questions_help`

### Files modified
- `src/db.js` — 1 new default
- `server.js` — 1 new rule
- `src/gameManager.js` — Fisher-Yates shuffle (~8 lines)
- `public/host/index.html` — checkbox in game settings tab
- `public/i18n.js` — 2 keys × 2 languages

### Verification
1. Enable shuffle in settings
2. Start same quiz twice → question order differs
3. Disable shuffle → order matches the authored sequence
4. Verify display and player screens show different-ordered questions

---

## 2.4 Randomize Answer Option Order Per Player

### Problem
Players sitting next to each other can copy the same tile color. Same quiz → same option positions every time.

### Current architecture
- `question-start` emits one shared `options` array to entire session room (socketHandlers.js line 72)
- Player page renders tiles by array index (play/index.html line 455)
- `submit-answer` sends `optionIndex` (play/index.html line 592)
- Server compares `optionIndex === question.correct_index` directly (gameManager.js line 205)
- No per-player mapping exists

### Implementation

**Step 1 — Add `shuffle_options` setting (same pattern as shuffle_questions)**
- SETTING_DEFAULTS, SETTING_RULES, Settings UI checkbox

**Step 2 — Per-player option shuffling in socket handler**
- Instead of broadcasting `question-start` to the whole room, emit individually to each player socket with shuffled options
- In socketHandlers.js `_startNextQuestion` (~line 72):
  ```js
  const basePayload = { questionIndex, totalQuestions, text, timeLimitSeconds, type, imageUrl, questionOpenAt };

  if (settings.shuffleOptions) {
    // Send unshuffled to host + display
    io.to(`host:${pin}`).to(`display:${pin}`).emit('question-start', { ...basePayload, options: q.options, players });

    // Send shuffled to each player individually
    for (const [socketId, player] of state.players.entries()) {
      if (!player.connected) continue;
      const perm = [0,1,2,3];
      // Fisher-Yates
      for (let i = perm.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      const shuffledOptions = perm.map(i => q.options[i]);
      // Store mapping so we can un-shuffle on submit
      player._optionMap = perm; // perm[displayIndex] = originalIndex
      io.to(socketId).emit('question-start', { ...basePayload, options: shuffledOptions });
    }
  } else {
    io.to(`session:${pin}`).emit('question-start', { ...basePayload, options: q.options, players });
  }
  ```

**Step 3 — Un-shuffle on answer submission**
- In `submit-answer` handler (socketHandlers.js line 289):
  ```js
  let actualIndex = optionIndex;
  if (state.settings.shuffleOptions && player._optionMap) {
    actualIndex = player._optionMap[optionIndex];
  }
  const result = gameManager.submitAnswer(socket.id, actualIndex);
  ```

**Step 4 — Handle display join room**
- Display page should join a dedicated `display:{pin}` room so it can receive unshuffled options
- In socketHandlers.js, when display joins, add `socket.join('display:' + pin)`

### Files modified
- `src/db.js` — 1 new default
- `server.js` — 1 new rule
- `src/socketHandlers.js` — per-player emit + un-shuffle logic (~40 lines)
- `public/host/index.html` — checkbox in game settings
- `public/display/index.html` — join `display:{pin}` room (~2 lines)
- `public/i18n.js` — 2 keys × 2 languages

### Verification
1. Enable shuffle options
2. Two players side by side see different option positions for same question
3. Both answer correctly → both get points (un-shuffling works)
4. Display screen shows canonical (unshuffled) options
5. Host tally shows correct aggregation
6. Answer reveal on player phone shows correct/wrong accurately
