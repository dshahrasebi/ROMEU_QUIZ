# Feature Specification: Live Audience Quiz Platform

**Feature Branch**: `001-live-quiz-platform`  
**Created**: March 19, 2026  
**Status**: Draft  
**Input**: User description: "Build a real-time audience quiz platform (Kahoot-style) for live training sessions with host admin panel, projector display view, and mobile player view."

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Host Runs a Live Quiz Session (Priority: P1)

A trainer (host) selects a previously saved quiz, starts a live game session, admits players as they join from their phones, advances questions one by one at their own pace, and ends the session with a final leaderboard. This is the core event that drives all value from the platform.

**Why this priority**: Without the ability to run a live session end-to-end, no other feature delivers value. This is the fundamental loop the entire platform exists to enable.

**Independent Test**: Can be fully tested with one manually created quiz (even with a single question) — a host starts a session, 2+ players join and answer, and the correct answer with score breakdown is revealed. Delivers the primary value independently.

**Acceptance Scenarios**:

1. **Given** a host has at least one saved quiz, **When** they select it and press "Start Live Game," **Then** a unique 6-digit PIN and a QR code are generated and displayed for players to join.
2. **Given** a live session is active and players have joined, **When** the host presses "Next Question," **Then** the question and its four answer options are simultaneously shown on the display view and all connected player screens.
3. **Given** a question is active, **When** the configured time limit for that question expires, **Then** the question closes automatically, no further answers are accepted, and the correct answer is revealed on the display view.
4. **Given** the host presses "End Game" after all questions have been shown, **Then** a final leaderboard is presented showing all players ranked by total score.

---

### User Story 2 — Host Creates and Manages Quizzes (Priority: P2)

A trainer builds a quiz library before the training session. They can create new quizzes, add multiple-choice questions to each quiz with a custom time limit per question, edit or delete existing questions, and delete entire quizzes they no longer need. All quizzes persist between sessions.

**Why this priority**: Quiz content must exist before any session can be run. Persistent storage removes the pain of re-entering content before every training, which is essential for recurring trainers.

**Independent Test**: Can be fully tested with no players or live session — a trainer creates a quiz, adds 3 questions with different time limits, edits one question's text, deletes another question, then confirms the quiz appears correctly in their saved quiz list after a page refresh.

**Acceptance Scenarios**:

1. **Given** the host is on the admin panel, **When** they fill in a quiz name and press "Create Quiz," **Then** the new empty quiz appears in their quiz list and is available to edit.
2. **Given** a quiz is open for editing, **When** the host adds a question with four answer options, one marked correct, and a custom time limit, **Then** the question is saved and visible in the quiz question list.
3. **Given** a quiz contains saved questions, **When** the host edits a question's text or correct answer, **Then** the updated content is immediately reflected and persisted.
4. **Given** a quiz exists in the host's library, **When** the host deletes it, **Then** the quiz is permanently removed and no longer appears in the list.
5. **Given** the host has created multiple quizzes, **When** they return to the admin panel in a new browser session, **Then** all previously created quizzes and their questions are still present.

---

### User Story 3 — Player Joins and Answers on Mobile (Priority: P3)

A participant uses their smartphone to join an active session by scanning the QR code or typing the 6-digit PIN, chooses a nickname, waits in the lobby until the host starts the first question, then taps one of four large colored answer tiles to respond. After submitting, they immediately see animated feedback indicating whether they were correct or wrong, along with their updated score and rank.

**Why this priority**: The player experience is the primary audience-facing surface. If players cannot join and respond smoothly on mobile, the platform has no audience engagement — its core purpose.

**Independent Test**: Can be tested end-to-end with a single player joining a session — the player scans the code, enters a nickname, sees the lobby, answers a question, receives correct/wrong feedback, and sees their score. Fully validates the mobile participation loop.

**Acceptance Scenarios**:

1. **Given** an active session PIN exists, **When** a player navigates to the join URL and enters the PIN and a nickname, **Then** they land in a waiting lobby that confirms they have joined.
2. **Given** a player is in the lobby, **When** other players join, **Then** player chips appear live without a page refresh, and the joined-player count updates.
3. **Given** the host advances to a question, **When** the question becomes active on the player's screen, **Then** four large colored tiles with the configured shapes (triangle = red, diamond = blue, circle = yellow, square = green) are displayed and tappable.
4. **Given** a player taps an answer tile, **When** the tap is registered, **Then** all four tiles are immediately disabled, the selected tile shows a visually distinct selected state, and the answer is submitted.
5. **Given** the question time expires and results are revealed, **When** the player's answer was correct, **Then** a large animated green checkmark appears on their screen; if wrong, a large animated red X appears.
6. **Given** the results feedback is shown, **When** the animation completes, **Then** the player sees their current total score counting up with a bounce animation and their current rank among all players.

---

### User Story 4 — Projector Display View Shows the Full Game (Priority: P4)

The host (or a dedicated display device) opens a separate full-screen display URL that projectors or large screens render throughout the event. Every phase of the game — join lobby, active question with countdown, answer reveal with distribution bars, between-question leaderboard, and final podium — is rendered on this screen automatically in sync with the host's controls.

**Why this priority**: In a live training room, the shared screen is the social anchor of the experience. Without an engaging display, participants lose context and the competitive atmosphere collapses. The visual quality must match commercial quiz platforms.

**Independent Test**: Can be tested by opening the display URL and running a session — verify each phase (lobby, question, reveal, leaderboard, podium) transitions and animates correctly without any additional configuration. Validates the entire audience-facing visual loop.

**Acceptance Scenarios**:

1. **Given** the display view URL for an active session is opened, **When** players have not yet been admitted to the first question, **Then** a full-screen join screen shows the large QR code and 6-digit PIN on the deep violet radial-gradient background (#46178F to #8B2FC9).
2. **Given** the host advances to a question, **When** the question becomes active, **Then** the question text appears in bold font at 72px or larger centered on the display, and an SVG countdown ring begins draining over the configured time limit.
3. **Given** the question time expires or the host reveals answers, **When** results are displayed, **Then** the correct answer is highlighted and animated horizontal bars grow proportionally to represent the response count per answer option.
4. **Given** answer results have been shown, **When** the host advances between questions, **Then** an animated staggered leaderboard appears with player entries sliding in sequentially by rank.
5. **Given** the host ends the game, **When** the final podium screen loads, **Then** columns for the top-3 players animate upward from zero height, with player names and scores labeled on each column.

---

### User Story 5 — Time-Based Scoring Rewards Fast Correct Answers (Priority: P5)

Players who answer correctly and quickly earn more points than players who answer correctly but slowly. Players who answer incorrectly or do not answer within the time limit earn zero points for that question.

**Why this priority**: Scoring is the competitive engine that creates engagement. Without time-based differentiation, all correct answers tie, eliminating the tension and excitement that motivates players to respond quickly.

**Independent Test**: Can be tested by running a session where two players answer the same question correctly — the player who answered earlier must have a higher score than the player who answered later. Fully validates the scoring rule in isolation.

**Acceptance Scenarios**:

1. **Given** two players both answer correctly, **When** Player A answered within 2 seconds and Player B answered within 8 seconds, **Then** Player A's score for that question is higher than Player B's.
2. **Given** a player answers incorrectly, **When** the correct answer is revealed, **Then** that player's total score does not increase for that question.
3. **Given** a player does not submit an answer before time expires, **When** results are revealed, **Then** that player earns zero points for that question.
4. **Given** the leaderboard is shown after a question, **When** scores are displayed, **Then** they reflect the cumulative sum of all points earned by each player across all answered questions so far.

---

### Edge Cases

- What happens when a player's device loses connectivity mid-session? Their last submitted answer is preserved; if no answer was submitted for the current question they receive zero points for it.
- What happens when two players choose the same nickname? The system prevents the duplicate and prompts the second player to choose a different name.
- What happens when the host advances to the next question while some players have not yet answered? Those players receive zero points for that question and the game proceeds normally.
- What happens when zero players join but the host advances questions? The session remains functional and shows empty leaderboards without crashing.
- What happens when the host tries to start a session with a quiz that has no questions? The system prevents the session from starting and informs the host to add at least one question first.
- What happens when the PIN a player enters does not match any active session? The player sees a clear error message and is invited to try again.
- What happens when 30 players are in the lobby simultaneously? The display view and host view remain responsive with no visible lag in answer count updates or leaderboard rendering.

## Requirements *(mandatory)*

### Functional Requirements

**Quiz Management**

- **FR-001**: Hosts MUST be able to create named quizzes stored persistently across browser sessions.
- **FR-002**: Hosts MUST be able to add multiple-choice questions to a quiz, each with exactly four answer options and one designated correct answer.
- **FR-003**: Hosts MUST be able to set an individual time limit per question, in seconds.
- **FR-004**: Hosts MUST be able to edit the text, answer options, correct answer, and time limit of any saved question.
- **FR-005**: Hosts MUST be able to delete individual questions from a quiz.
- **FR-006**: Hosts MUST be able to delete entire quizzes from their library.
- **FR-007**: All quiz data MUST persist and be retrievable after the host closes and reopens their browser.

**Session Lifecycle**

- **FR-008**: Hosts MUST be able to start a live game session from any saved quiz that contains at least one question.
- **FR-009**: The system MUST generate a unique 6-digit numeric PIN for each new session.
- **FR-010**: The system MUST generate a scannable QR code that encodes the player join URL pre-filled with the session PIN.
- **FR-011**: Hosts MUST be able to advance to the next question manually via a single control action.
- **FR-012**: Question timers MUST count down automatically from the configured time limit and close the question upon expiry even if the host has not acted.
- **FR-013**: Hosts MUST be able to end the game session at any time, triggering the final podium screen on all connected views.
- **FR-014**: Each active session MUST have a dedicated display URL accessible in any browser without authentication.

**Player Participation**

- **FR-015**: Players MUST be able to join a session by entering the 6-digit PIN on the join page or by scanning the QR code.
- **FR-016**: Players MUST choose a non-empty nickname upon joining.
- **FR-017**: The system MUST prevent duplicate nicknames within the same session.
- **FR-018**: Players MUST see a lobby screen after joining that shows the current joined-player count updating live as others join, with a chip or avatar appearing for each new player.
- **FR-019**: Players MUST see the four answer tiles rendered in their designated colors (red, blue, yellow, green) with their signature shapes (triangle, diamond, circle, square) when a question is active.
- **FR-020**: Players MUST be prevented from changing or re-submitting their answer after tapping a tile.
- **FR-021**: Players MUST see animated correct or wrong feedback immediately after the question closes.
- **FR-022**: Players MUST see their current total score and current rank after each question result is revealed.

**Real-Time Synchronization**

- **FR-023**: All connected views (host, display, all players) MUST update in real time without requiring any page refresh.
- **FR-024**: The host view MUST show a live count of how many players have responded per answer option as responses arrive during an active question.
- **FR-025**: The display view MUST transition automatically through all game phases (lobby → question → reveal → leaderboard → podium) in sync with host actions.

**Scoring**

- **FR-026**: Correct answers MUST earn points calculated inversely proportional to the time elapsed between question display and the player's submission — faster answers earn more points.
- **FR-027**: Incorrect answers MUST earn zero points.
- **FR-028**: Unanswered questions MUST earn zero points.
- **FR-029**: The total score displayed for each player MUST equal the sum of all points earned across all completed questions in the session.

**Visual & Interaction Quality**

- **FR-030**: The display view background MUST use the deep violet radial gradient from #46178F to #8B2FC9 across all game phases.
- **FR-031**: Question text on the display view MUST render in bold font at 72px or larger.
- **FR-032**: The countdown timer on the display view MUST be rendered as an SVG ring that visually drains from full to empty over the question duration.
- **FR-033**: Answer distribution bars on the display reveal screen MUST animate proportionally to response counts.
- **FR-034**: The between-question leaderboard on the display MUST animate entries in staggered sequence, one entry at a time.
- **FR-035**: The final podium columns for the top-3 players MUST animate upward from zero height to their relative score heights.
- **FR-036**: Player answer tiles on mobile MUST collectively occupy at least 50% of the viewport height.
- **FR-037**: Correct/wrong feedback animations on the player view MUST use a spring-style scale-in animation.
- **FR-038**: The score increase shown to a player after a correct answer MUST be accompanied by a counting-up bounce animation.

### Key Entities

- **Quiz**: A named collection of questions owned by the host. Has a name and an ordered list of questions. Persists independently of any session.
- **Question**: A single multiple-choice item belonging to a quiz. Has question text, exactly four answer options (each with display text), one designated correct answer index, and a time limit in seconds.
- **Session**: An instance of a live game run from a specific quiz. Has a unique 6-digit PIN, a status (lobby / question-active / question-reveal / leaderboard / ended), a reference to the source quiz, a current question index, and a collection of joined players.
- **Player**: A participant in a specific session. Has a nickname, a connection state, a total score, and a record of answers submitted per question.
- **Answer Submission**: A record of one player's response to one question. Has the chosen option index and the elapsed time in milliseconds at the moment of submission.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A host can create a quiz with 10 questions and launch a live session within 5 minutes of first using the platform.
- **SC-002**: A player can join an active session, enter a nickname, and see the first question on their phone within 30 seconds of scanning the QR code.
- **SC-003**: The platform supports at least 30 simultaneous players in a single session without visible lag in the display view or player response acknowledgement.
- **SC-004**: All connected views (display, host, players) reflect question state changes within 1 second of the host triggering the change.
- **SC-005**: 95% of players successfully submit an answer on their first attempt without UI confusion — answer tiles respond reliably to a single touch on mobile.
- **SC-006**: The display view is visually indistinguishable from a production quiz platform in screenshots — the violet gradient, countdown ring, answer distribution bars, staggered leaderboard, and podium columns all render with polished animation quality.
- **SC-007**: Quiz content created by the host persists and is fully intact after closing and reopening the browser the following day.
- **SC-008**: Two players who both answer the same question correctly — one within 2 seconds, one within 8 seconds — receive different point totals for that question, with the faster player scoring higher.

## Assumptions

- A single host per session is assumed; no multi-host or collaborative editing scenario is in scope.
- The platform is intended for use on a shared network (such as a training room's WiFi) but should also function over the public internet.
- No authentication is required for players — they join anonymously by PIN and nickname only.
- The host admin panel is protected by a server-side login form that POSTs credentials to an Express endpoint. The server compares the submitted password against the `HOST_PASSWORD` environment variable using `crypto.timingSafeEqual()` to prevent timing attacks. On success, the server issues a signed `httpOnly`, `secure`, `sameSite=strict` session cookie via `express-session` with a 4-hour TTL. All subsequent requests to `/host/*` validate the session server-side. A logout button destroys the session and clears the cookie. The password is never transmitted after the initial POST and never stored client-side.
- Session history and past game results are not required to be stored after a session ends — only current active session data needs to persist during gameplay.
- Each question has exactly four answer options; variable option counts are out of scope.
- Audio (sound effects, background music) is out of scope for this iteration.
- The platform targets modern mobile browsers; no native app installation should be required of players.

## Clarifications

### Session 2026-03-19

- Q: How should the host admin panel be protected? → A: Server-side session cookie via `express-session`; login form POSTs to Express endpoint; `crypto.timingSafeEqual()` for password comparison; `httpOnly`/`secure`/`sameSite=strict` cookie; 4-hour TTL; logout button. Password only lives in `HOST_PASSWORD` env var — never client-side, never in source code.
- Q: What happens to an active game session if the server restarts mid-game? → A: Active session state (current question index, player list, scores, all answer submissions) is persisted to SQLite on every state transition. On server startup, if an interrupted session exists in the database it is automatically resumed — the host panel reflects the last known state and players who reconnect are restored to their scores.
- Q: How should the QR code know the correct public URL to encode? → A: A `BASE_URL` environment variable is set in the Railway dashboard (e.g. `https://romeu-quiz.up.railway.app`). The server reads it at startup and uses it when generating QR codes (`BASE_URL/play?pin=XXXXXX`). For local development, `BASE_URL=http://localhost:3000` is set in `.env`. The variable is required — the server must refuse to start if it is absent.
- Q: How should multiple quiz rounds within one training session be handled? → A: Only one active session exists at a time. When the host starts a new session, the previous session is marked `ended` in SQLite (preserving its results for reference) and a fresh in-memory game begins. The host can freely run back-to-back rounds with any saved quiz without restarting the server.
- Q: What is the maximum expected number of simultaneous players per session? → A: Up to 30 players. This is the target concurrent-user ceiling the implementation must be designed and tested against. SQLite WAL mode handles this volume without contention. No special Socket.io fanout optimisation is required beyond standard room broadcasting.
