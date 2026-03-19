# Tasks: Live Audience Quiz Platform

**Input**: Design documents from `/specs/001-live-quiz-platform/`
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/rest-api.md ✓, contracts/socket-events.md ✓, quickstart.md ✓

**Tests**: Not in scope per plan.md (YAGNI — no testing requested in spec)

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no shared-file conflict)
- **[Story]**: Which user story this task belongs to (US1–US5)
- File paths are relative to repository root
- `server.js` and `src/socketHandlers.js` grow across multiple phases — edit sequentially within those files

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization — npm manifest, environment config, and Railway deployment scaffold.

- [X] T001 Create `package.json` with runtime dependencies: express, socket.io, better-sqlite3, express-session, qrcode, dotenv; add `"start": "node server.js"` script; set `"engines": {"node": ">=20.0.0"}`
- [X] T002 [P] Create `.env.example` with all six documented variables and inline comments: BASE_URL (required — used for QR code generation; server refuses to start without it), HOST_PASSWORD (required — never commit), SESSION_SECRET (required — generate with `openssl rand -hex 32`), PORT (optional, default 3000), NODE_ENV (optional — set to `production` on Railway), DATA_PATH (optional — defaults to `/data`; use `./data` locally)
- [X] T003 [P] Create `railway.toml` per research.md: `[build] builder = "NIXPACKS"`, `[deploy] startCommand = "node server.js"`, `healthcheckPath = "/health"`, `healthcheckTimeout = 30`, `restartPolicyType = "ON_FAILURE"`, `restartPolicyMaxRetries = 3`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Full SQLite schema and helpers, in-memory game engine with scoring formula, Express server skeleton, and design system CSS. All five user stories depend on this phase being complete.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. T004 → T005 → T006 must run in sequence (each depends on the previous). T007 can run in parallel alongside T004–T006.

- [X] T004 Create `src/db.js`: open database at `path.join(process.env.DATA_PATH ?? '/data', 'quiz.db')`; run `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`; execute full DDL from data-model.md (CREATE TABLE IF NOT EXISTS for quizzes, questions, sessions, players, answer_submissions) plus indexes `idx_questions_quiz`, `idx_players_session`, `idx_submissions_session_question`; export prepared-statement helpers — quiz: `createQuiz(name)`, `getAllQuizzes()` (with question count subquery), `getQuizById(id)` (with questions ordered by sort_order), `updateQuizName(id, name)`, `deleteQuiz(id)` (cascade via FK); question: `addQuestion(quizId, text, options, correctIndex, timeLimitSeconds)` (sort_order = MAX(sort_order)+1), `updateQuestion(id, fields)`, `deleteQuestion(id)`; session: `createSession(pin, quizId, startedAt)`, `getSessionByPin(pin)`, `updateSessionStatus(id, status, currentQuestionIndex)`, `saveSessionStateJson(id, stateJson)`, `getInterruptedSession()` (WHERE status NOT IN ('ended') ORDER BY started_at DESC LIMIT 1), `markSessionEnded(id, endedAt)`; player: `createPlayer(sessionId, nickname, socketId)`, `getPlayersBySession(sessionId)`, `updatePlayerScore(playerId, newScore)`, `setPlayerConnected(playerId, connected)`, `updatePlayerSocketId(playerId, socketId)`; submission: `createAnswerSubmission(sessionId, playerId, questionId, optionIndex, elapsedMs, pointsEarned)`

- [X] T005 Create `src/gameManager.js`: export singleton `game` object (initialized null when no session is active); define in-memory state shape matching data-model.md — `{ sessionId, pin, quizId, questions[], currentQuestionIndex, status, players: Map<playerId, {id, nickname, score, connected, socketId}>, submissions: Map<questionId, Map<playerId, {optionIndex, elapsedMs, pointsEarned}>>, questionStartTime, questionTimer, qrDataUrl }`; implement `calculateScore(elapsed_ms, timeLimitSeconds)` → `Math.round(500 + 500 * Math.max(0, (timeLimitSeconds * 1000 - elapsed_ms) / (timeLimitSeconds * 1000)))` per research.md (range 500–1000 for correct, caller passes 0 for incorrect); implement `startGame(sessionRow, questions, qrDataUrl)` (populate state, set status='lobby', currentQuestionIndex=-1); `restoreFromDb(sessionRow)` (parse state_json, rebuild players Map and submissions Map from DB via db.getPlayersBySession); `serializeState()` → JSON string of all state (excluding timer references); `isActive()` → game !== null; `clearActiveTimer()` (clearTimeout + set questionTimer=null); `getLeaderboard(limit?)` → players sorted by score desc, dense rank assigned; `startQuestion(questionIndex, io)` (set currentQuestionIndex, set questionStartTime=Date.now(), start setTimeout for timeLimitSeconds, on timeout call revealQuestion automatically, emit `question-start` to `session:${pin}` with {questionIndex, totalQuestions, displayText, timeLimitSeconds, options} — no correctIndex); `revealQuestion(io)` (clearActiveTimer, iterate all players, for each player with submission calculate pointsEarned via calculateScore if correct else 0, call db.updatePlayerScore, increment in-memory score, build playerResults map keyed by nickname {correct, pointsEarned, newScore}, emit `question-reveal` to `session:${pin}` with {questionIndex, correctIndex, tally[4], playerResults}, update status='question-reveal', save state to DB); `advanceToLeaderboard(io)` (compute getLeaderboard, emit `leaderboard-update` to `session:${pin}` with {leaderboard:[{rank,nickname,score}]}, update status='leaderboard', save state); `endGame(io)` (build podium top-3 and allPlayers full list, emit `game-ended` to `session:${pin}` with {podium, allPlayers, archived:false}, db.markSessionEnded, set game=null)

- [X] T006 Create `server.js`: `require('dotenv').config()`; validate required env vars (throw descriptive Error for each missing: BASE_URL, HOST_PASSWORD, SESSION_SECRET); `const app = express()`; `app.set('trust proxy', 1)` (required for Railway TLS termination per research.md); mount express-session middleware with `{ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 14400000 } }`; mount `express.json()` and `express.urlencoded({extended: false})`; serve static dirs: `app.use('/host', express.static('public/host'))`, `app.use('/display', express.static('public/display'))`, `app.use('/play', express.static('public/play'))`, `app.use('/shared.css', express.static('public/shared.css'))`; `GET /health` → 200 `{status:'ok'}`; create `const server = http.createServer(app)` and `const io = new Server(server, {transports:['websocket'],cors:false})`; require and call `registerHandlers(io, db, gameManager)` from `src/socketHandlers.js`; startup crash recovery: `const interrupted = db.getInterruptedSession(); if (interrupted) { gameManager.restoreFromDb(interrupted); console.warn('Resumed interrupted session PIN', interrupted.pin, 'at question', interrupted.current_question_index); }`; `server.listen(process.env.PORT || 3000, () => console.log('Listening on port', process.env.PORT || 3000))`

- [X] T007 [P] Create `public/shared.css`: CSS custom properties for tile palette (`--tile-red: #E21B3C; --tile-blue: #1368CE; --tile-yellow: #D89E00; --tile-green: #26890C`); body font: `font-family: 'Nunito', sans-serif`; `.gradient-bg { background: radial-gradient(ellipse at center, #8B2FC9 0%, #46178F 100%); min-height: 100vh; color: #fff }`; `.answer-tile { min-height: 25vh; display: flex; align-items: center; justify-content: center; gap: 12px; border-radius: 12px; cursor: pointer; user-select: none; touch-action: manipulation; transition: transform 0.1s; font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 1.25rem }` `.answer-tile:active { transform: scale(0.96) }` `.answer-tile.disabled { pointer-events: none; opacity: 0.6 }` `.answer-tile.selected { outline: 4px solid #fff; outline-offset: -4px }`; tile color classes: `.tile-red { background: var(--tile-red) }` `.tile-blue { background: var(--tile-blue) }` `.tile-yellow { background: var(--tile-yellow) }` `.tile-green { background: var(--tile-green) }`; shape icons as large Unicode spans: triangle `▲`, diamond `◆`, circle `●`, square `■`; SVG ring: `.countdown-ring circle { transition: stroke-dashoffset linear; fill: none; stroke: #fff; stroke-width: 8 }`; `.pillar { transform-origin: bottom; border-radius: 8px 8px 0 0 }`; keyframes — `@keyframes spring-in { 0% { transform: scale(0) } 60% { transform: scale(1.2) } 100% { transform: scale(1) } }` `.spring-in { animation: spring-in 0.45s cubic-bezier(.34,1.56,.64,1) forwards }`; `@keyframes count-bounce { 0%,100% { transform: translateY(0) } 45% { transform: translateY(-10px) } 65% { transform: translateY(-5px) } }` `.count-bounce { animation: count-bounce 0.6s ease-out }`; `@keyframes stagger-slide { from { transform: translateX(-120%); opacity: 0 } to { transform: translateX(0); opacity: 1 } }`; `@keyframes pillar-rise { from { transform: scaleY(0) } to { transform: scaleY(1) } }`; `.confetti-piece { position: fixed; top: -10px; left: var(--x); width: 8px; height: 16px; background: var(--color); border-radius: 2px; animation: confetti-fall var(--duration) ease-in var(--delay) forwards; pointer-events: none; z-index: 9999 }` plus `@keyframes confetti-fall` per research.md CSS snippet (translateY 110vh + rotateZ + rotateX + opacity 0)

**Checkpoint**: Foundation complete — database schema ready, game engine implemented, server skeleton running, design system defined. User story implementation can begin.

---

## Phase 3: User Story 1 — Host Runs a Live Quiz Session (Priority: P1) 🎯 MVP

**Goal**: A host can log in, start a live game session from a saved quiz, advance through questions with manual controls, see live answer tallies, and end the session at a final leaderboard. A single row seeded directly in SQLite is sufficient to test US1 independently.

**Independent Test**: Seed one quiz + one question in SQLite directly. Log in at `/host/login`, click Start Session on that quiz, verify 6-digit PIN and QR code appear, open `/display/?pin=XXXXXX`, emit `host-join` via a browser WebSocket client and receive `host-state`, advance through `question-active → question-reveal → leaderboard → ended`, confirm each correct event broadcasts to `session:PIN`.

- [X] T008 [US1] Add host auth routes to `server.js`: define `requireHost` middleware (check `req.session.isHost`; if request has `Accept: application/json` return `401 {error:'Unauthorized'}`; else redirect `/host/login`); `GET /host/login` → `res.sendFile(path.resolve('public/host/login.html'))`; `POST /host/login` (urlencoded body; allocate equal-length buffers and compare via `crypto.timingSafeEqual` per research.md padding snippet: `const len = Math.max(expected.length, provided.length); const a = Buffer.alloc(len); expected.copy(a); const b = Buffer.alloc(len); provided.copy(b); if (crypto.timingSafeEqual(a,b))…`; on success set `req.session.isHost = true`, redirect `/host/`; on fail redirect `/host/login?error=1`); `POST /host/logout` (req.session.destroy, redirect `/host/login`); `GET /host/` protected by requireHost → serve `public/host/index.html`

- [X] T009 [US1] Add session control REST API to `server.js` (all behind `requireHost`): `POST /host/api/session/start` — get quiz with questions from db, return 400 if quiz has 0 questions or is not found, generate 6-digit PIN as `(Math.floor(100000 + Math.random() * 900000)).toString()` with a retry loop checking `db.getSessionByPin` for collision, generate QR via `qrcode.toDataURL(process.env.BASE_URL + '/play?pin=' + pin)`, call `db.createSession`, call `gameManager.startGame`, call `db.saveSessionStateJson`, return 201 `{sessionId, pin, qrDataUrl, quizName, questionCount}`; `POST /host/api/session/next` — validate `gameManager.isActive()` (400 if not), dispatch based on `game.status`: lobby → call `gameManager.startQuestion(0, io)`; question-active → call `gameManager.revealQuestion(io)`; question-reveal → call `gameManager.advanceToLeaderboard(io)`; leaderboard → if more questions call `gameManager.startQuestion(next, io)` else call `gameManager.endGame(io)`; return 200 `{status, questionIndex}`; `POST /host/api/session/reveal` — validate status==='question-active' (400 if not), call `gameManager.revealQuestion(io)`, return 200 `{status:'question-reveal', questionIndex}`; `POST /host/api/session/end` — validate isActive (400 if not), call `gameManager.endGame(io)`, return 200 `{status:'ended'}`; public `GET /api/session/:pin` — `db.getSessionByPin(pin)`; if not found or status==='ended' return 404 `{valid:false, error:'Session not found or has ended'}`; else 200 `{valid:true, status}`

- [X] T010 [US1] Create `src/socketHandlers.js`: export `registerHandlers(io, db, gameManager)` function; **host-join**: require `socket.request.session.isHost` (emit `{event:'error', message:'Unauthorized'}` and return if not); validate `gameManager.isActive()` and pin matches; join socket to `session:${pin}` and `host:${pin}` rooms; emit `host-state` to socket: `{sessionId, pin, status, currentQuestionIndex, questionCount: game.questions.length, quizName, qrDataUrl, players: [...game.players.values()].map(p=>({nickname:p.nickname, score:p.score, connected:p.connected}))}`; **host-next/host-reveal/host-end**: auth guard (socket.request.session.isHost), then call same logic as REST equivalents using shared gameManager methods and the `io` reference from closure; **display-join** `{pin}`: join `session:${pin}` + `display:${pin}` rooms; emit `display-state` snapshot — same shape as `host-state` PLUS `currentQuestion: {displayText, timeLimitSeconds, options, elapsedMs: Date.now()-game.questionStartTime}` when `game.status === 'question-active'` (never include `correctIndex` in this payload); **disconnect**: iterate `game.players` to find player matching `socket.id`; if found call `db.setPlayerConnected(player.id, 0)` and update in-memory `player.connected = false`

- [X] T011 [P] [US1] Create `public/host/login.html`: `<!DOCTYPE html>` with `<meta charset="utf-8">` and viewport meta; Nunito font link (`https://fonts.googleapis.com/css2?family=Nunito:wght@700;900&display=swap`); Tailwind CDN script; link `/shared.css`; `.gradient-bg` body; centered card with white background, rounded-2xl, shadow; `<form method="POST" action="/host/login">`; `<label>Host Password</label>`; `<input type="password" name="password" autocomplete="current-password" required class="…">`; styled "Sign In" submit button; error paragraph (shown only when `new URLSearchParams(location.search).get('error')` equals `'1'`) with message "Incorrect password — try again"

- [X] T012 [US1] Create `public/host/index.html`: Nunito font link; Tailwind CDN; link `/shared.css`; Socket.io CDN script (`/socket.io/socket.io.js`); two main sections toggled by JS — **(A) Quiz Library panel** (shown on load): heading "Your Quizzes"; quiz list rendered from `GET /host/api/quizzes`; each quiz card shows name, question count badge, and "▶ Start Session" button (POST to `/host/api/session/start`, on success store `{pin, qrDataUrl}` and switch to Game panel); empty-state message when no quizzes; **(B) Game Control panel** (hidden until session starts): session header showing PIN in large monospace font + `<img id="qr-img">` (src=qrDataUrl, 160×160); current phase label (lobby / question-active / question-reveal / leaderboard / ended); question progress counter "Q N / Total"; question text display; 4 colored tally bars (red, blue, yellow, green) each showing a label and a fill-width bar updated on `answer-tally-update` events from host:PIN room (`tally[i]` counts); connected player list/count updated on `lobby-update`; primary action button that changes per phase: lobby → "Start First Question", question-active → "Reveal Answers", question-reveal → "Next →" + "End Game", leaderboard → "Next Question" + "End Game", ended → "Back to Quizzes"; action buttons POST to corresponding REST endpoints; Socket.io client: on session start emit `socket.emit('host-join', {pin})`; handle `question-start` (update question text, reset tally bars, update phase label), `question-reveal` (highlight correct bar, show final tally), `leaderboard-update` (render top 10 in sidebar), `game-ended` (show podium summary with top-3 nicknames + scores, "Back to Quizzes" button)

**Checkpoint**: US1 independently testable — host auth, session start, question flow, and all host events work end-to-end with seeded quiz data.

---

## Phase 4: User Story 2 — Host Creates and Manages Quizzes (Priority: P2)

**Goal**: Host can create named quizzes, add/edit/delete questions with time limits, and confirm the library persists across page refreshes.

**Independent Test**: No live session needed — log in, create a quiz, add 3 questions with different time limits, edit one question's text, delete another question, refresh the page, confirm quiz and 2 remaining questions are still present with correct data.

- [X] T013 [US2] Add quiz CRUD REST API to `server.js` (all behind `requireHost`): `GET /host/api/quizzes` → `db.getAllQuizzes()` (200 array `[{id, name, questionCount, createdAt}]`); `POST /host/api/quizzes` → validate `name` is non-empty string 1–100 chars (400 `{error:'name is required'}` if invalid), `db.createQuiz(name)`, 201 `{id, name, createdAt}`; `GET /host/api/quizzes/:id` → `db.getQuizById(id)` with questions, 404 `{error:'Quiz not found'}` if missing; `PUT /host/api/quizzes/:id` → validate name, `db.updateQuizName(id, name)`, 200, 404 if missing; `DELETE /host/api/quizzes/:id` → `db.deleteQuiz(id)` (cascade FK deletes questions), 204, 404 if missing; `POST /host/api/quizzes/:id/questions` → validate all fields: text non-empty, options = JSON array of exactly 4 non-empty strings (400 `{error:'options must be an array of exactly 4 non-empty strings'}` if not), correctIndex integer 0–3, timeLimitSeconds integer 5–120; `db.addQuestion(…)`, 201 full question object; `PUT /host/api/questions/:id` → partial update (only apply provided fields, validate each), `db.updateQuestion(id, fields)`, 200 updated object, 404 if not found; `DELETE /host/api/questions/:id` → `db.deleteQuestion(id)`, 204, 404 if not found

- [X] T014 [US2] Enhance `public/host/index.html` with quiz management UI in the Quiz Library panel: "＋ New Quiz" button opens an inline name form (text input + "Create" button → POST `/host/api/quizzes`, re-render list on success); each quiz card expands to show its question list on click; "＋ Add Question" button per card opens an inline question form with: text `<textarea>`, four answer option `<input>` fields with color-coded tile-color labels (red=0, blue=1, yellow=2, green=3), correct-answer `<select>` or styled radio buttons, time limit `<input type="number" min="5" max="120">` (default 20), "Save Question" button → POST `/host/api/quizzes/:id/questions`, re-render question list; "✎ Edit" button per question (pre-fills form → PUT `/host/api/questions/:id`); "🗑 Delete" button per question (browser `confirm()` dialog → DELETE `/host/api/questions/:id`, refresh list); "✎ Rename" per quiz card (inline input → PUT `/host/api/quizzes/:id`); "Delete Quiz" button (confirm → DELETE `/host/api/quizzes/:id`, remove card); re-fetch and re-render quiz list after every mutation; disable "▶ Start Session" button if quiz has 0 questions (show tooltip "Add at least one question first")

**Checkpoint**: US2 independently testable — complete quiz CRUD flows through the UI with full persistence, independently of any live session.

---

## Phase 5: User Story 3 — Player Joins and Answers on Mobile (Priority: P3)

**Goal**: A player can join by PIN or QR, pick a nickname, see the lobby with live player chips, tap a large colored tile to answer, and receive animated correct/wrong feedback with score and rank after each question.

**Independent Test**: Start a session; open `/play` on a phone; enter the PIN; submit a nickname; see the lobby screen; wait for host to start a question; tap any tile; confirm tile locks immediately; on question-reveal see correct checkmark or wrong X with spring animation and score count-up.

- [X] T015 [US3] Add player socket handlers to `src/socketHandlers.js`: **join-lobby** `{pin, nickname}`: validate `gameManager.isActive()` and game pin matches (emit `join-error {message:'Session not found'}` if not); check game.status === 'lobby' (emit `join-error {message:'Session has already started'}` if not); check `game.players.size < 30` (emit `join-error {message:'Session is full'}` if full); trim nickname, validate 1–20 chars (emit `join-error {message:'Nickname must not be empty'}` if empty); check case-insensitive uniqueness — search `game.players` for match on `nickname.toLowerCase()`; if **existing player found** (reconnect path): update `player.socketId`, call `db.updatePlayerSocketId`, `db.setPlayerConnected(id,1)`, update in-memory `player.connected=true`; emit `join-success {playerId:player.id, nickname, playerCount:game.players.size}` to socket; **else** (new player): `db.createPlayer(game.sessionId, trimmedNickname, socket.id)`, add to `game.players` Map; join socket to `session:${pin}` room; store socketId; emit `join-success {playerId, nickname, playerCount}`; **both paths**: emit `lobby-update {players:[...game.players.values()].map(p=>({nickname:p.nickname})), playerCount:game.players.size}` to `session:${pin}` room; **submit-answer** `{optionIndex}`: validate `game.status === 'question-active'` (emit `answer-locked {message:'Question is no longer accepting answers'}` if not); find player by socket.id (skip if not found); check player has NOT already submitted for `game.currentQuestionIndex` (skip silently — UNIQUE DB constraint also prevents double-store); compute `elapsed_ms = Date.now() - game.questionStartTime`; get current question, check `optionIndex === question.correctIndex`; compute `pointsEarned` (calculateScore if correct, else 0); `db.createAnswerSubmission(game.sessionId, player.id, question.id, optionIndex, elapsed_ms, pointsEarned)`; update `game.submissions` Map; emit `answer-accepted {optionIndex}` to socket; compute tally across all submissions for current question (count per optionIndex 0–3); emit `answer-tally-update {tally, totalAnswered, totalPlayers:game.players.size}` to `host:${pin}` room; if `totalAnswered >= connectedPlayerCount` (all connected players answered): call `gameManager.revealQuestion(io)`

- [X] T016 [US3] Add public session validation endpoint to `server.js`: `GET /api/session/:pin` — call `db.getSessionByPin(req.params.pin)`; if not found or `session.status === 'ended'` return 404 `{valid:false, error:'Session not found or has ended'}`; else return 200 `{valid:true, status:session.status}`

- [X] T017 [US3] Create `public/play/index.html`: Nunito font link; Tailwind CDN; link `/shared.css`; Socket.io CDN; manage 5 screens via JS show/hide — **(1) PIN screen**: large numeric text input (max 6 chars), "Join →" button; on submit fetch `GET /api/session/${pin}`; show inline error if invalid; advance to nickname screen on success; **(2) Nickname screen**: text input (max 20 chars, trim on submit), "Enter Game" button; emit `socket.emit('join-lobby', {pin, nickname})`; on `join-error` display error message inline and stay; on `join-success` store `{playerId, nickname}` and advance to lobby screen; **(3) Lobby screen** (`gradient-bg`): "Get ready! 🎮" heading; player count badge updating on `lobby-update`; chips grid where each new nickname from `lobby-update.players` appears as a colored pill with the player's initial letter (CSS `animation: spring-in 0.3s`); "Waiting for host to start…" pulse text; **(4) Question screen**: on `question-start`: render 4 `.answer-tile` elements in a 2×2 grid filling ≥ 50% viewport height (`grid-template-rows: 1fr 1fr; min-height: 50vh` for the tile container); red tile (index 0) with `▲` triangle icon; blue tile (index 1) with `◆` diamond icon; yellow tile (index 2) with `●` circle icon; green tile (index 3) with `■` square icon; on tile tap: emit `socket.emit('submit-answer', {optionIndex: i})`, add `.disabled` to all 4 tiles, add `.selected` to tapped tile; on `answer-accepted`: confirm lock (noop if already done); on `answer-locked`: apply same lock; **(5) Feedback screen**: on `question-reveal`: extract own result from `data.playerResults[nickname]`; if **correct**: show large green checkmark `div` with `.spring-in`; inject 30 `.confetti-piece` elements into body with randomised CSS custom properties `--x`, `--color`, `--duration`, `--delay`, `--rot` per research.md snippet; if **wrong**: show large red × div with `.spring-in`; animate score counter from previous score to `result.newScore` using `.count-bounce` class and a `setInterval` increment loop; show rank: "Rank N of M"; show "Waiting for next question…" fade-in after 1.5s; on `question-start` again: clear feedback screen and return to question screen; on `game-ended`: show final score, final rank, and "Thanks for playing! 🎉" message

**Checkpoint**: US3 independently testable — full mobile player flow from PIN entry through animated feedback and final score.

---

## Phase 6: User Story 4 — Projector Display View (Priority: P4)

**Goal**: A full-screen display view auto-connects by PIN, renders every game phase with production-quality Kahoot-matching visuals and animations, and stays in sync throughout the session without any page refresh.

**Independent Test**: Open `/display/?pin=XXXXXX` in a browser; run a full session from lobby to podium; verify each phase renders and transitions: lobby shows QR + PIN on gradient; question shows 72px+ text + SVG ring draining; reveal shows correct answer highlight + distribution bars growing; leaderboard entries slide in staggered; podium columns animate upward.

- [X] T018 [US4] Create `public/display/index.html`: Nunito font link; Tailwind CDN; link `/shared.css`; Socket.io CDN; full-viewport `.gradient-bg` body with `overflow: hidden`; on page load: read `pin` from `new URLSearchParams(location.search).get('pin')`; connect Socket.io and emit `display-join {pin}`; maintain a `currentState` variable; implement `renderPhase(state)` function that swaps innerHTML of a single `#stage` container div based on `state.status`; handle the following events — `display-state` (initial sync on connect/reconnect: call renderPhase), `question-start` (update state + renderPhase), `question-reveal` (update state + renderPhase), `leaderboard-update` (update state + renderPhase), `game-ended` (update state + renderPhase); **Phase renderers**: **(a) lobby**: QR code `<img>` centered (320×320px), PIN in `font-size:80px; letter-spacing:0.25em; font-weight:900` below it, "Scan to join" subtitle, player count from lobby-update (listen separately to update count without full re-render); **(b) question-active** (`question-start`): question text `font-size: clamp(2.5rem, 5vw, 4.5rem); font-weight: 900; text-align: center` in top ~40% of screen; 4 answer option tiles in 2×2 grid with option text + shape icon (colored backgrounds, same colors as player tiles); SVG countdown ring: `<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" stroke-width="8" stroke="#fff" fill="none" stroke-dasharray="${2*Math.PI*54}" stroke-dashoffset="0" id="ring-circle"/></svg>`; animate ring by decrementing `stroke-dashoffset` from `0` to `circumference` over `timeLimitSeconds * 1000` ms using `requestAnimationFrame`; on `display-state` mid-question use `elapsedMs` to compute starting dashoffset offset; **(c) question-reveal**: correct option tile gets `outline: 6px solid #fff; transform: scale(1.05)` with `.spring-in`; 4 horizontal distribution bar rows: each `<div class="bar">` starts at `width: 0`, transitions to `width: ${pct}%` via `setTimeout(()=>el.style.width=…, 50)` after render (CSS `transition: width 0.8s ease-out`); color-coded to tile color; vote count label right-aligned; **(d) leaderboard-update**: "🏆 Leaderboard" heading; up to 10 player rows rendered with `animation: stagger-slide 0.4s ease-out both` and `animation-delay: ${i * 120}ms`; rank number + nickname + score; **(e) game-ended / podium**: check `data.archived === true` and show "Session ended" screen instead of podium if so; else render top-3 podium columns: all 3 columns have heights proportional to scores (tallest = 100%, others = score/max * 100%); render order: 2nd place left, 1st place center (tallest), 3rd place right; each column `animation: pillar-rise 0.8s ease-out both; animation-delay: ${[0.6,1.0,0.3][rank-1]}s` (dramatic stagger: 3rd fires at 0.3s, 2nd at 0.6s, 1st last at 1.0s); player name + score label on column; full `allPlayers` ranked list scrollable below podium

**Checkpoint**: US4 independently testable — display view renders all game phases with Kahoot-matching visual quality.

---

## Phase 7: User Story 5 — Time-Based Scoring Rewards Fast Correct Answers (Priority: P5)

**Goal**: The scoring formula correctly awards higher points to faster correct answers; all views reflect accurate cumulative scores and ranks; the leaderboard is correctly sorted with dense ranking.

**Independent Test**: Run a session; have 2 players both answer the same question correctly — one within 2 seconds, one within 8 seconds of a 20-second question; verify via `question-reveal` playerResults that the faster player earned more points (≥ ~880 vs ~580); confirm leaderboard at game-ended is sorted by score desc.

- [X] T019 [US5] Finalize scoring pipeline in `src/gameManager.js` and `src/socketHandlers.js`: in `revealQuestion(io)` — iterate all session players; for each player, check `game.submissions.get(currentQuestionId)?.get(player.id)`; if submission exists and `optionIndex === question.correctIndex`: compute `pointsEarned = calculateScore(submission.elapsedMs, question.timeLimitSeconds)`; else `pointsEarned = 0`; call `db.updatePlayerScore(player.id, player.score + pointsEarned)` and update in-memory `player.score += pointsEarned`; build `playerResults` keyed by nickname `{correct: bool, pointsEarned: int, newScore: int}`; emit `question-reveal` payload with complete `{questionIndex, correctIndex, tally, playerResults}`; in `getLeaderboard()` — sort players by score descending using a stable sort; assign ranks using dense ranking (players with equal score share the same rank; next distinct score gets the next integer rank); in `advanceToLeaderboard(io)` — emit `leaderboard-update {leaderboard: getLeaderboard(10)}` (top 10 by score); in `endGame(io)` — emit `game-ended {podium: getLeaderboard(3), allPlayers: getLeaderboard(), archived: false}` where both arrays include rank numbers; verify edge cases: player who never submitted a `submit-answer` for a question gets `pointsEarned = 0` (no entry in submissions Map → falls through to 0 branch); player who submitted incorrect answer gets `pointsEarned = 0`

**Checkpoint**: US5 independently testable — two players who answer at different speeds receive meaningfully different scores for the same correct answer, and leaderboard reflects cumulative totals accurately.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Repository hygiene, edge-case hardening aligned to spec edge cases, and end-to-end smoke validation per quickstart.md.

- [X] T020 [P] Create `.gitignore`: exclude `node_modules/`, `data/*.db`, `.env`, `*.log`, `.DS_Store`, `npm-debug.log*`

- [X] T021 [P] Create `data/.gitkeep`: ensures the `data/` directory is tracked by git so `mkdir -p data` is not required as a manual step before first run; document in comment at top of `.gitkeep` that this directory holds the local SQLite file

- [X] T022 Harden edge cases across `server.js`, `src/socketHandlers.js`, and `src/gameManager.js`: (a) `POST /host/api/session/start` — confirm 400 with `{error:'Quiz must have at least one question'}` when questions array is empty; (b) PIN generation — add retry loop with `getSessionByPin` collision check (max 10 retries; log error and return 500 if exhausted — practically impossible but handles theoretic case); (c) `GET /api/session/:pin` — ensure clear 404 JSON consumed by `/play` PIN screen error display; (d) zero-player session — `startQuestion`, `revealQuestion`, and `endGame` must not crash when `game.players` Map is empty (empty leaderboard renders gracefully); (e) 30-player cap — `join-lobby` emits `join-error {message:'Session is full'}` when `game.players.size >= 30`; (f) host advances when no active session — all four REST session endpoints return `400 {error:'No active session'}` when `!gameManager.isActive()`; (g) `submit-answer` received after question closed — emit `answer-locked {message:'Question is no longer accepting answers'}` per socket contract; (h) player duplicate nickname on join attempt (non-reconnect) — emit `join-error {message:'Nickname already taken'}` with case-insensitive check

- [X] T023 End-to-end smoke test per `quickstart.md` validation: run `npm install`; copy `.env.example` to `.env` and set `BASE_URL=http://localhost:3000`, a test HOST_PASSWORD, and a 32-byte SESSION_SECRET; run `mkdir -p data`; start server with `node server.js`; confirm startup log "Listening on port 3000"; confirm `GET /health` returns `{status:'ok'}`; log in at `/host/login`; create a quiz named "Smoke Test" with 2 questions (different time limits); start a live session and note the PIN; open `/display/?pin=PIN` and confirm lobby screen with QR code visible; join 2 players from separate tabs via `/play`; confirm player chips appear in display lobby; host advances to first question; both players submit answers (one immediately, one after 5 seconds); host reveals; confirm question-reveal shows correct answer and distribution bar; confirm player feedback shows checkmark/X; advance to final podium; confirm faster correct player has higher score; stop server, restart with `node server.js`, confirm quiz data persists after restart

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | Depends On | Notes |
|-------|-----------|-------|
| Setup (1) | — | Start immediately |
| Foundational (2) | Phase 1 complete | T004 → T005 → T006 sequential; T007 parallel |
| US1 (3) | Phase 2 complete | T008 → T009 → T010 sequential in server.js + socketHandlers.js; T011 [P] after T008 |
| US2 (4) | Phase 2 complete | T013 extends server.js (after T009); T014 extends host/index.html (after T012) |
| US3 (5) | Phase 2 + US1 | T015 extends socketHandlers.js (after T010); T016 extends server.js (after T013); T017 [new file] |
| US4 (6) | Phase 2 + US1 | T018 new file; needs display-join from T010 and active session to test |
| US5 (7) | US1 + US3 | Finalizes scoring pipeline wired across T005, T015, T010 |
| Polish (8) | All desired stories | T020 + T021 [P]; T022 + T023 sequential |

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational — no other story dependency
- **US2 (P2)**: Can start after Foundational — independent of US1 at the DB level; shares `server.js` and `host/index.html` so edit sequentially after US1 tasks on those files
- **US3 (P3)**: Depends on US1 (active session required for player join; `socketHandlers.js` must have T010 before T015)
- **US4 (P4)**: Depends on US1 (display-join handler in T010 required); display HTML is a new file and can be worked in parallel to US3
- **US5 (P5)**: Depends on US1 (revealQuestion in gameManager) + US3 (submit-answer scoring in socketHandlers)

### Within Each Story

- Server-side before client-side (db/gameManager/server.js before HTML)
- Same-file edits are always sequential (server.js, socketHandlers.js)
- Different-file tasks marked [P] can run truly in parallel
- Player socket events (T015) must be added after host events (T010) — same file, T010 first

### Parallel Opportunities

| Phase | Parallel batch |
|-------|---------------|
| Phase 1 | T002 [P] + T003 [P] in parallel after T001 |
| Phase 2 | T007 [P] runs alongside the T004 → T005 → T006 sequence |
| Phase 3 | T011 [P] runs alongside T012 after T008–T010 complete |
| Phase 5 | T015 (socketHandlers.js) + T017 (new HTML file) in parallel; T016 (server.js) after T013 |
| Phase 6 | T018 (new HTML file) can overlap with US3 tasks (different file) |
| Phase 8 | T020 [P] + T021 [P] in parallel |

---

## Parallel Example: User Story 3

```bash
# After T010 (socketHandlers host events) and T013 (quiz CRUD REST) both complete:

# These run in parallel (different files):
T015 — Add player socket handlers in src/socketHandlers.js
T017 — Create public/play/index.html

# T016 must follow T013 (both edit server.js):
T016 — Add GET /api/session/:pin to server.js
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Seed quiz in SQLite, log in, run host session lifecycle end-to-end
5. Deploy to Railway if ready — host game loop works with manually seeded data

### Incremental Delivery

1. Setup + Foundational → server boots and responds to /health
2. Add US1 → full host session lifecycle works (no quiz UI yet, no player view)
3. Add US2 → quiz CRUD UI works; host can now build their library
4. Add US3 → **Full MVP**: live session end-to-end with real players on phones ← deploy here
5. Add US4 → display view works on projector with all animations
6. Add US5 → scoring pipeline verified and finalized
7. Polish → hardened edge cases + smoke test ← production-ready deploy

### Parallel Team Strategy

With 2 developers, after Foundation:

- **Developer A**: US1 (session lifecycle, host controls)
- **Developer B**: US2 (quiz CRUD REST + UI) — different files, no conflict with US1 server-side
- After US1 merges: Developer A → US3; Developer B → US4 (different HTML files, no conflict)
- US5 once US1 + US3 both complete

---

## Notes

- No tests in scope — YAGNI per plan.md (spec explicitly excludes testing)
- `[P]` = different files, no shared-file dependency conflict within that phase
- `server.js` is edited across T006, T008, T009, T013, T016 — always edit sequentially, in that order
- `src/socketHandlers.js` is edited across T010, T015 — T010 first
- `public/shared.css` (T007) is the single CSS file — all four HTML views link it; serves at `/shared.css`
- Tailwind CDN + Google Fonts Nunito (700, 900) are loaded in every HTML view via CDN — no build pipeline required
- `correctIndex` must **never** appear in `question-start`, `display-state`, or any player-facing payload — only in `question-reveal`
- `answer-tally-update` goes to `host:PIN` room only — prevents players from seeing live distribution before reveal
- Session crash recovery (T006) uses `getInterruptedSession()` on startup — scores and progress survive Railway redeploys
- Commit after each task or logical group; stop at any phase checkpoint to validate the story independently
- Total: **23 tasks** across 8 phases (T001–T023)

---

## Task Count Summary

| Phase | Story | Tasks | Parallelizable |
|-------|-------|-------|---------------|
| Phase 1: Setup | — | 3 (T001–T003) | 2 (T002, T003) |
| Phase 2: Foundational | — | 4 (T004–T007) | 1 (T007) |
| Phase 3: US1 (P1) 🎯 | US1 | 5 (T008–T012) | 1 (T011) |
| Phase 4: US2 (P2) | US2 | 2 (T013–T014) | 0 |
| Phase 5: US3 (P3) | US3 | 3 (T015–T017) | 1 (T015+T017 pair) |
| Phase 6: US4 (P4) | US4 | 1 (T018) | 1 (vs US3 work) |
| Phase 7: US5 (P5) | US5 | 1 (T019) | 0 |
| Phase 8: Polish | — | 4 (T020–T023) | 2 (T020, T021) |
| **Total** | | **23 tasks** | **8 parallel slots** |
