# Romeu Quiz

A real-time, Kahoot-style audience quiz platform built for live training sessions. Hosts create and manage quizzes via a password-protected admin panel, participants join from their phones by scanning a QR code or entering a 6-digit PIN, and a separate projector display view drives the shared-screen experience throughout the session.

---

## Features

- **Host admin panel** — create, edit, and delete quizzes and questions; start and control live sessions; see live answer tallies per option as players respond
- **Player mobile view** — join by QR code or PIN, pick a nickname, tap large coloured answer tiles, and get instant correct/wrong animated feedback with a score reveal after each question
- **Projector display view** — full-screen violet-gradient interface that automatically transitions through every game phase: lobby → question + countdown ring → answer distribution → leaderboard → final podium
- **Time-based scoring** — faster correct answers earn more points; wrong or missed answers earn zero
- **Persistent quiz library** — all quizzes and questions survive server restarts via SQLite
- **Session recovery** — interrupted live sessions are automatically resumed from the last known state on server restart
- **Real-time sync** — all three views (host, display, players) update instantly via Socket.io without page refreshes
- **Security** — CSRF protection, HTTP-only/strict session cookies, Helmet security headers, and login rate limiting built in

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 20 |
| Web framework | Express 4 |
| Real-time | Socket.io 4 |
| Database | SQLite via `better-sqlite3` |
| QR codes | `qrcode` |
| Security | `helmet`, `express-session`, `express-rate-limit` |
| Deployment | Railway (Nixpacks) |
| Frontend | Vanilla JS + Tailwind CSS CDN |

---

## Local Development

### Prerequisites

- Node.js LTS (20.x)
- npm (bundled with Node.js)

### Setup

```bash
# 1. Clone the repo
git clone <repo-url>
cd romeu-quiz

# 2. Install dependencies
npm install

# 3. Copy the environment template and fill in values
cp .env.example .env

# 4. Create the local data directory for SQLite
mkdir data

# 5. Start the server
node server.js
```

The server will print:
```
SQLite database ready at ./data/quiz.db
Listening on port 3000
```

### URLs

| URL | Purpose |
|-----|---------|
| `http://localhost:3000/host/login` | Host login |
| `http://localhost:3000/host/` | Host admin panel |
| `http://localhost:3000/display/` | Projector display view |
| `http://localhost:3000/play` | Player join page |
| `http://localhost:3000/health` | Health check endpoint |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_URL` | **yes** | Public-facing URL for QR code generation. Example: `http://localhost:3000` or `https://your-app.up.railway.app` |
| `HOST_PASSWORD` | **yes** | Admin panel password. Compared with `crypto.timingSafeEqual` — never stored client-side. |
| `SESSION_SECRET` | **yes** | Signs session cookies. Generate with `openssl rand -hex 32`. |
| `PORT` | no | HTTP port. Defaults to `3000`. Set automatically by Railway. |
| `NODE_ENV` | no | Set to `production` to enable `secure` cookies and CSP headers. Required on Railway. |
| `DATA_PATH` | no | Directory for `quiz.db`. Defaults to `/data`. Auto-detects Railway's mounted Volume via `RAILWAY_VOLUME_MOUNT_PATH` in production — leave unset there. Use `./data` locally. |

> **Security**: `HOST_PASSWORD` and `SESSION_SECRET` must never be committed to source control. Keep them in environment variables only.

---

## Running a Session

1. Log in at `/host/login`
2. **Create Quiz** → enter a name → **Add Questions** (each question has 4 options, 1 correct, and a per-question time limit)
3. Click **Start Live Game** on any quiz with at least one question — a 6-digit PIN and QR code are generated
4. Open `/display/` full-screen on the projector or shared display
5. Participants scan the QR code or go to `<BASE_URL>/play?pin=XXXXXX` and enter a nickname
6. Watch the lobby populate live — click **Start** when ready
7. Click **Next Question** to advance; questions close automatically when the timer reaches zero
8. Click **Reveal Answers** at any time to show the correct answer and response distribution early
9. Click **End Game** to show the final podium

---

## Deployment (Railway)

1. Push the repository to GitHub
2. Go to [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Attach a **Volume** and mount it at `/data` for SQLite persistence (under **Settings → Volumes → Add Volume**, Mount Path = `/data`).
   - **Note on Branch / PR Environments:** Railway creates isolated environments for each branch or PR deploy. Persistent Volumes in Railway are environment-specific and not shared by default. To preserve data on a branch environment, attach a Volume at `/data` for that branch service as well, or use the host panel's **📥 Export All** / **📤 Import Quiz** feature to migrate quiz libraries between environments.
   - **Do not set `DATA_PATH` in Railway.** The server auto-detects the Volume via Railway's own `RAILWAY_VOLUME_MOUNT_PATH` variable. If `DATA_PATH` is left over from an earlier setup pointing at a relative path (e.g. `./data`), the server now ignores it in production and logs a warning — but it's safest to simply delete that variable in Railway's **Variables** tab.
   - If a deploy's logs show `WARNING: No RAILWAY_VOLUME_MOUNT_PATH detected`, no Volume is attached to that service/environment and all data will be lost on the next redeploy — attach one before creating quizzes.
4. Add the following environment variables in the **Variables** tab:

```
BASE_URL=https://your-app.up.railway.app
HOST_PASSWORD=<your chosen password>
SESSION_SECRET=<openssl rand -hex 32>
NODE_ENV=production
```

`PORT` is injected automatically by Railway — do not set it manually. Leave `DATA_PATH` unset (defaults to `/data` where the volume is mounted).

The `railway.toml` in the repository root configures the Nixpacks build, start command (`node server.js`), and health check path (`/health`) automatically.

---

## Testing

```bash
# REST API tests
node tests/rest-test.js

# Socket.io integration tests
node tests/socket-test.js

# Edge-case tests (duplicate nicknames, empty quizzes, etc.)
node tests/edge-test.js

# Stress test (30 simulated concurrent players)
node tests/stress-test.js

# Quick smoke test
node smoke-test.js
```

Tests require a running server instance. Start it with `node server.js` before running any test file.

---

## Project Structure

```
server.js              # Express app, auth, REST routes, Socket.io bootstrap
src/
  db.js                # SQLite schema, queries, and migrations
  gameManager.js       # In-memory game state (sessions, players, scores)
  socketHandlers.js    # Socket.io event handlers and game phase logic
  i18n-server.js       # Server-side i18n helper
  profanity.js         # Nickname profanity filter
public/
  host/                # Host admin panel HTML + JS
  display/             # Projector display view HTML + JS
  play/                # Player join/answer view HTML + JS
  audio.js             # Shared audio controller
  i18n.js              # Client-side i18n loader
specs/
  001-live-quiz-platform/  # Feature spec, API contract, Socket event contract
tests/                 # Automated test suites
```

---

## License

MIT
