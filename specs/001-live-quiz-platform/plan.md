# Implementation Plan: Live Audience Quiz Platform

**Branch**: `001-live-quiz-platform` | **Date**: 2026-03-19 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-live-quiz-platform/spec.md`

## Summary

Single-process Node.js service (Express + Socket.io) delivering a Kahoot-style live quiz platform. A host admin panel manages a quiz library in SQLite, launches live game sessions with 6-digit PINs and QR codes, and controls question flow. Players join on mobile phones and submit answers through four colored tiles. A projector display view renders all game phases (lobby → question + SVG countdown → reveal + distribution bars → staggered leaderboard → podium) in full-screen high-contrast visual quality matching Kahoot. All state transitions are persisted to SQLite on every change enabling crash-resilient session resumption. Deployed as a single Railway service with a volume-mounted SQLite database.

## Technical Context

**Language/Version**: Node.js LTS (20.x)  
**Primary Dependencies**: express, socket.io, better-sqlite3, express-session, qrcode, crypto (built-in)  
**Storage**: SQLite via `better-sqlite3`; WAL journal mode; database file at `/data/quiz.db`  
**Testing**: Not in scope (YAGNI — no testing requested in spec)  
**Target Platform**: Railway PaaS (production), macOS/Linux local dev  
**Project Type**: web-service — single Node.js process serving static HTML + REST API + WebSockets  
**Performance Goals**: 100 ms p95 event delivery to all clients; 30 simultaneous players per session; <200 ms answer acknowledgement round-trip  
**Constraints**: Single Node.js process; no external databases; no build pipeline; SQLite WAL mode required; `BASE_URL` env var required at startup (server refuses to start if absent); `HOST_PASSWORD` and `SESSION_SECRET` required  
**Scale/Scope**: 30 simultaneous players per session; 1 active session at a time; quiz library of arbitrary size

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| # | Principle | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Mobile-First Participant Interfaces | ✅ PASS | `public/play/index.html` designed for phone viewports; answer tiles occupy ≥ 50% viewport height (FR-036); single-column layout; Tailwind via CDN; touch targets ≥ 48×48 px enforced by tile size |
| 2 | Real-Time Responsiveness | ✅ PASS | Socket.io WebSocket transport (long-polling disabled); single-process event loop; broadcasting to 30 clients is negligible; 100 ms p95 budget met |
| 3 | Visual Clarity for Large-Screen Display | ✅ PASS | 72px+ question text on display (FR-031); SVG countdown ring (FR-032); deep violet radial gradient (#46178F→#8B2FC9) persists across all display phases (FR-030); animated podium, leaderboard, distribution bars |
| 4 | Minimal Infrastructure | ✅ PASS | Single Node.js process; SQLite only; no Redis, no queues, no microservices; Socket.io co-located in `server.js` |
| 5 | YAGNI — Scope Locked to Live Quiz Session | ✅ PASS | All features (quiz CRUD, session lifecycle, player answers, scoring, all display views) directly exercised during a live session; no analytics dashboards or persistent user accounts |

All gates pass. No violations require justification.

## Project Structure

### Documentation (this feature)

```text
specs/001-live-quiz-platform/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── rest-api.md      # Phase 1 output
│   └── socket-events.md # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
server.js                    # Express + Socket.io entrypoint; env validation; startup
src/
├── db.js                   # SQLite schema init, quiz CRUD, session persistence
├── gameManager.js          # In-memory game state + scoring + timer management
└── socketHandlers.js       # Socket.io event wiring (join, answers, host control)
public/
├── shared.css              # Design system: gradient, tile colors, all animations
├── host/
│   ├── index.html          # Host admin panel + game control (session-protected)
│   └── login.html          # Host login form (public)
├── display/
│   └── index.html          # Projector display view (public, auto-connects)
└── play/
    └── index.html          # Mobile player view (public, join by PIN or QR)
railway.toml
.env.example
package.json
```

**Structure Decision**: Single Node.js project, no frontend build step. HTML/CSS/JS served directly by Express `static` middleware from `public/`. All server logic in `src/`. SQLite at `/data/quiz.db` on Railway volume; `./data/quiz.db` locally via `DATA_PATH` env var. Login page (`login.html`) is a separate static file that the session auth middleware explicitly exempts.
