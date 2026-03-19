# Research: Live Audience Quiz Platform

**Phase**: 0 | **Date**: 2026-03-19 | **Spec**: [spec.md](spec.md)

All NEEDS CLARIFICATION items from Technical Context resolved. No open unknowns remain.

---

## 1. Time-Based Scoring Formula

**Decision**: Kahoot-style speed bonus — correct answers earn 500–1000 points proportional to how quickly the player answered.

```js
// In src/gameManager.js
function calculateScore(elapsed_ms, time_limit_seconds) {
  const time_limit_ms = time_limit_seconds * 1000;
  const ratio = Math.max(0, (time_limit_ms - elapsed_ms) / time_limit_ms);
  return Math.round(500 + 500 * ratio);
  // instant answer  → 1000 points
  // last-moment answer → ~500 points
  // incorrect / no answer → 0 points (caller responsibility)
}
```

**Rationale**: Matches expectations set by Kahoot. Every correct answer earns at least 500 points so slow typists aren't punished for a slightly late tap — this preserves engagement across all speed tiers.

**Alternatives considered**:
- Linear 0–1000 range (rejected: answering 1 second before deadline earns near-zero, which feels unfair)
- Fixed 1000 for any correct answer (rejected: removes time tension, defeats spec requirement SC-008)

---

## 2. Express-Session Configuration (Railway)

**Decision**: `express-session` with in-memory store, `trust proxy: 1`, 4-hour cookie TTL.

```js
// server.js
app.set('trust proxy', 1); // Railway terminates TLS; requests arrive as HTTP internally

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 4 * 60 * 60 * 1000 // 4 hours
  }
}));
```

**`trust proxy: 1`** is required because Railway's edge terminates TLS and forwards plain HTTP to the Node.js process. Without it, `req.secure` is always false and `secure: true` cookies are never sent back to the browser.

**Host login security** — `crypto.timingSafeEqual` requires equal-length buffers; padding to the maximum length prevents length-based timing leaks:

```js
app.post('/host/login', express.urlencoded({ extended: false }), (req, res) => {
  const { password } = req.body;
  if (!password) return res.redirect('/host/login?error=1');

  const expected = Buffer.from(process.env.HOST_PASSWORD);
  const provided = Buffer.from(password);
  const len = Math.max(expected.length, provided.length);
  const a = Buffer.alloc(len); expected.copy(a);
  const b = Buffer.alloc(len); provided.copy(b);

  if (crypto.timingSafeEqual(a, b)) {
    req.session.isHost = true;
    return res.redirect('/host/');
  }
  return res.redirect('/host/login?error=1');
});
```

**Rationale**: In-memory store is appropriate — single-instance Railway deployment, no session clustering. Host re-login is trivial after restart; game state is preserved separately in SQLite.

**Alternatives considered**:
- SQLite session store (rejected: YAGNI; in-memory sufficient for single host user)
- Redis session store (rejected: violates Principle IV Minimal Infrastructure)

---

## 3. Socket.io Room Strategy

**Decision**: Three room types, all namespaced by session PIN.

| Room | Subscribers | Purpose |
|------|------------|---------|
| `session:PIN` | host + display + all players | Game phase broadcasts: `question-start`, `question-reveal`, `leaderboard-update`, `game-ended`, `lobby-update` |
| `host:PIN` | host socket only | Host-exclusive: `answer-tally-update`, `host-state` snapshot |
| `display:PIN` | display socket only | Reserved for display-exclusive events if needed |

Players are in `session:PIN` only. Direct socket emissions (`.to(socket.id)`) are used for personalised events: `join-success`, `join-error`, `answer-accepted`.

**Rationale**: Room-based broadcasting eliminates O(N) socket-ID iteration. Sending tally updates only to `host:PIN` prevents players from learning the answer distribution before the reveal — a correctness requirement.

**Alternatives considered**:
- Single room for all (rejected: tally updates would leak answer counts to players mid-question)
- Separate Socket.io namespaces per role (rejected: overkill for a single-session service; complicates reconnection logic)

---

## 4. SQLite Session Persistence for Crash Resilience

**Decision**: Serialize full active game state as JSON into `sessions.state_json` on every state transition. Restore on startup if an interrupted session is found.

**What is persisted** (example `state_json`):
```json
{
  "currentQuestionIndex": 2,
  "status": "question-reveal",
  "players": [
    { "id": 1, "nickname": "Alice", "score": 1750, "connected": true }
  ],
  "submissions": {
    "5": { "1": { "optionIndex": 2, "elapsedMs": 3200, "pointsEarned": 842 } }
  }
}
```

**Startup resumption** (in `server.js`):
```js
const interrupted = db.getInterruptedSession(); // status NOT IN ('ended')
if (interrupted) {
  gameManager.restoreFromDb(interrupted);
  console.warn(`Resumed interrupted session PIN ${interrupted.pin} at question ${interrupted.current_question_index}`);
}
```

When a player reconnects after a crash, their existing `players` record is matched by `session_id + nickname (COLLATE NOCASE)`. Their socket is updated; no re-registration needed.

**Rationale**: Railway instances restart on deploy and can OOM-restart. Best-effort state persistence ensures the trainer doesn't lose mid-session scores. Socket.io connections cannot be restored, but scores and progress are the valuable part.

**Alternatives considered**:
- No persistence (rejected: unacceptable data loss during Railway redeploys)
- Full event-sourced log replay (rejected: complex; state snapshot is sufficient and simpler)

---

## 5. Railway Deployment

**Decision**: `railway.toml` with Nixpacks builder; start command `node server.js`; Railway volume at `/data`.

```toml
# railway.toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node server.js"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

```js
// server.js — bind to Railway's $PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
```

**Volume**: Railway volume named `data` mounted at `/data`. SQLite DB at `/data/quiz.db`.  
**Local dev**: `DATA_PATH=./data node server.js`. `db.js` uses `process.env.DATA_PATH ?? '/data'` for the DB path.

**Rationale**: Nixpacks auto-detects Node.js from `package.json` — zero configuration needed. Volume mount is the only Railway-native way to persist SQLite between deployments; everything else is ephemeral.

**Alternatives considered**:
- Dockerfile (rejected: adds maintenance overhead; Nixpacks handles the Node.js build automatically)
- Turso / LibSQL cloud (rejected: external database — violates Principle IV Minimal Infrastructure)

---

## 6. CSS Confetti (30 Positioned Divs)

**Decision**: Inject 30 `<div class="confetti-piece">` elements via JS at correct-answer reveal; animate via a single `@keyframes confetti-fall` with per-element CSS custom properties for variation.

```css
/* public/shared.css */
.confetti-piece {
  position: fixed;
  top: -10px;
  left: var(--x);
  width: 8px;
  height: 16px;
  background: var(--color);
  border-radius: 2px;
  animation: confetti-fall var(--duration) ease-in var(--delay) forwards;
  pointer-events: none;
  z-index: 9999;
}

@keyframes confetti-fall {
  0%   { transform: translateY(0)     rotateZ(0deg)            rotateX(0deg);   opacity: 1; }
  100% { transform: translateY(110vh) rotateZ(calc(var(--rot) * 4)) rotateX(720deg); opacity: 0; }
}
```

```js
// public/play/index.html <script>
function launchConfetti() {
  const colors = ['#E21B3C', '#1368CE', '#D89E00', '#26890C', '#ffffff', '#f5a623'];
  for (let i = 0; i < 30; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.setProperty('--x',        `${Math.random() * 100}vw`);
    el.style.setProperty('--color',    colors[i % colors.length]);
    el.style.setProperty('--rot',      `${Math.random() * 360}deg`);
    el.style.setProperty('--duration', `${1.5 + Math.random() * 1}s`);
    el.style.setProperty('--delay',    `${Math.random() * 0.5}s`);
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }
}
```

**Rationale**: CSS keyframe animation runs on the compositor thread (GPU-accelerated). No JS animation loop required. Cleanup via `animationend` prevents DOM leakage.

**Alternatives considered**:
- 30 separate `@keyframes scatter-N` rules (rejected: impossible to randomize in plain CSS without a preprocessor)
- `canvas-confetti` npm-CDN library (rejected: external JS dependency; pure-CSS approach is sufficient and keeps the page self-contained)

---

## 7. QR Code Generation

**Decision**: `qrcode` npm package; generate base64 PNG data URL server-side at session start; send to host via REST response body and broadcast to display view via Socket.io `host-state` / `display-state` payloads.

```js
// src/db.js or server.js
const QRCode = require('qrcode');

async function generateSessionQR(pin, baseUrl) {
  const url = `${baseUrl}/play?pin=${pin}`;
  return QRCode.toDataURL(url, {
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  });
}
```

The returned data URL (`data:image/png;base64,...`) is stored in the in-memory game state and embedded directly as `<img src="...">` in both the host panel and display lobby screen. No file system writes needed.

**Rationale**: Zero disk writes; data URL works natively in `<img src>`. QR is generated once per session and reused. `BASE_URL` env var guarantees the correct public URL is encoded.

**Alternatives considered**:
- Write PNG file to `public/qr/` (rejected: requires cleanup logic; data URL is simpler and avoids stale files)
- Client-side QR generation with a JS library (rejected: adds a CDN dependency to the host page; server-side generation keeps the host page self-contained and ensures the correct base URL is used)

---

## 8. Express–Socket.io Session Sharing

**Decision**: Share the express-session middleware with Socket.io via `io.engine.use()`. Authenticate host sockets by checking `socket.request.session.isHost`.

```js
const sessionMiddleware = session({ /* ... */ });
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware); // injects session into socket.request.session

// src/socketHandlers.js — host event guard
function requireHostSocket(socket, next) {
  if (socket.request.session?.isHost) return next();
  next(new Error('Unauthorized'));
}
```

Host-only socket events (`host-next`, `host-reveal`, `host-end`) validate `requireHostSocket` before processing.

**Rationale**: Single session store; no separate JWT or custom socket handshake token. Host login established at HTTP POST level propagates automatically to Socket.io layer via the shared cookie.

**Alternatives considered**:
- Separate socket auth token passed as query param (rejected: redundant with session cookie; complicates logout; token visible in server logs)
- No socket auth for host events (rejected: security violation — any connected socket could advance or end the session)

---

## 9. Concurrent Session Archival

**Decision**: On `POST /host/api/session/start`, check for any session where `status != 'ended'`. If found: set `status = 'ended'`, `ended_at = Date.now()` in SQLite, emit `game-ended` to all sockets in the old session room, then create the new session.

```js
// server.js POST /host/api/session/start
const active = db.getActiveSession();
if (active) {
  db.endSession(active.id);
  io.to(`session:${active.pin}`).emit('game-ended', { archived: true });
  gameManager.clear();
}
// ... create new session
```

**Rationale**: Spec requires "starting a new session archives the previous one." Emitting `game-ended` to stale sockets ensures player/display screens transition to a terminal state rather than hanging on a question screen.

---

## 10. Duplicate Nickname & Player Limit Enforcement

**Decision**: Both checks are performed synchronously in the `join-lobby` Socket.io handler before inserting a player record.

```js
// src/socketHandlers.js — join-lobby handler
const nickname = data.nickname?.trim();
if (!nickname) return socket.emit('join-error', { message: 'Nickname must not be empty' });

const game = gameManager.getActive();
if (!game)                                  return socket.emit('join-error', { message: 'Session not found' });
if (game.status === 'ended')                return socket.emit('join-error', { message: 'Session has already ended' });
if (game.players.size >= 30)                return socket.emit('join-error', { message: 'Session is full' });
if (game.hasDuplicateNickname(nickname))    return socket.emit('join-error', { message: 'Nickname already taken' });
```

`hasDuplicateNickname` performs a case-insensitive comparison against existing player nicknames in the in-memory Map. The SQLite `players` table also has a `UNIQUE(session_id, nickname COLLATE NOCASE)` constraint as a hard safety net.

---

## Open Questions

None. All technical unknowns resolved. Constitution check passes 5/5 gates.
