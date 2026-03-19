# Quickstart: Live Audience Quiz Platform

**Branch**: `001-live-quiz-platform` | **Spec**: [spec.md](spec.md)

---

## Prerequisites

- Node.js LTS (20.x) — `node --version` should print `v20.x.x`
- npm (bundled with Node.js)
- A Railway account for production deployment

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Create your local .env file from the template
cp .env.example .env

# 3. Open .env and set required values (see Environment Variables below)
#    BASE_URL, HOST_PASSWORD, and SESSION_SECRET are required — server won't start without them

# 4. Create the local SQLite data directory
mkdir -p data

# 5. Start the server
node server.js
```

The server will log:
```
SQLite database ready at ./data/quiz.db
Listening on port 3000
```

Open the following URLs:
| URL | Purpose |
|-----|---------|
| `http://localhost:3000/host/login` | Host admin login |
| `http://localhost:3000/host/` | Host admin panel (requires login) |
| `http://localhost:3000/display/` | Projector display view |
| `http://localhost:3000/play` | Player join page |
| `http://localhost:3000/health` | Health check |

---

## Environment Variables

Copy `.env.example` and fill in every required value before starting.

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_URL` | **yes** | Public-facing URL used for QR code generation. Server **refuses to start** if absent. Example: `http://localhost:3000` or `https://your-app.up.railway.app` |
| `HOST_PASSWORD` | **yes** | Admin panel password. Never commit to source. Compared via `crypto.timingSafeEqual`. |
| `SESSION_SECRET` | **yes** | Signs session cookies. Use a random 32+ byte hex string. Generate: `openssl rand -hex 32` |
| `PORT` | no | HTTP port. Defaults to `3000`. Set automatically by Railway. |
| `NODE_ENV` | no | Set to `production` to enable `secure` session cookies. Required on Railway. |
| `DATA_PATH` | no | Directory for `quiz.db`. Defaults to `/data` (Railway volume). Use `./data` locally. |

> **Security note**: `HOST_PASSWORD` and `SESSION_SECRET` must never appear in source code or be committed to git. They live exclusively in environment variables.

---

## Running a Session End-to-End

1. Log in to the host panel at `/host/login`
2. Click **Create Quiz**, enter a name, then **Add Questions**
3. Click **Start Live Game** on any quiz with at least one question
4. A 6-digit PIN and QR code are generated — share them with participants
5. Open `/display/` full-screen on the projector (bookmark or send the URL)
6. Participants scan the QR code or navigate to `<BASE_URL>/play?pin=XXXXXX` and enter a nickname
7. Watch the lobby count update live — click **Start** when ready
8. Click **Next Question** to advance through questions
9. Click **Reveal Answers** to show the correct answer and distribution before advancing (or let the timer expire)
10. Click **End Game** at any time to show the final podium

---

## Deploy to Railway

### One-time setup

1. Push the repository to GitHub
2. Go to [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select your repository

### Environment variables (Railway dashboard → Variables tab)

```
BASE_URL=https://your-app.up.railway.app
HOST_PASSWORD=<your chosen password>
SESSION_SECRET=<openssl rand -hex 32 output>
NODE_ENV=production
```

`PORT` is set automatically by Railway — do not override it.

### Volume for SQLite persistence

1. Railway dashboard → your service → **Volumes** tab
2. **Add Volume** → mount path: `/data`

Without the volume, the SQLite database resets on every deployment.

### Deploy

Push to your main branch — Railway auto-deploys via Nixpacks.

`railway.toml` configures:
- Build: Nixpacks (auto-detects Node.js from `package.json`)
- Start command: `node server.js`
- Health check: `GET /health` (30-second timeout)
- Restart policy: on failure, up to 3 retries

---

## Session Resilience

If Railway restarts the service mid-session (deploy, OOM, crash), the server automatically resumes the interrupted session on startup:

```
[WARN] Resumed interrupted session PIN 483920 at question 3/10
```

Scores, question progress, and player list are restored from SQLite. Players reconnect by re-loading their phone browser and re-entering the PIN + nickname (existing player records are matched by session + nickname, scores preserved).

---

## File Reference

| File | Purpose |
|------|---------|
| `server.js` | Express + Socket.io entrypoint; env validation; route registration; startup |
| `src/db.js` | SQLite init (`PRAGMA WAL`); quiz CRUD; session persistence (`saveSessionState`) |
| `src/gameManager.js` | In-memory active game state; scoring formula; timer management |
| `src/socketHandlers.js` | Socket.io event wiring; host auth guard; player join/answer handling |
| `public/shared.css` | Full design system: radial gradient, tile colors, all animation keyframes |
| `public/host/index.html` | Host admin panel (quiz library, game controls) — session-protected SPA |
| `public/host/login.html` | Host login form (public) |
| `public/display/index.html` | Projector display view — all game phases, auto-connects via Socket.io |
| `public/play/index.html` | Mobile player view — pin entry, answer tiles, feedback, score |
| `railway.toml` | Railway build and deploy configuration |
| `.env.example` | Template for required environment variables |
