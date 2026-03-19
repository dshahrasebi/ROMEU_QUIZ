<!--
  SYNC IMPACT REPORT
  Version change: (unversioned template) → 1.0.0
  Added sections:
    - Core Principles (5 new principles, initial ratification)
    - Technology Constraints (new)
    - Development Workflow (new)
    - Governance (new)
  Removed sections: N/A — initial ratification
  Templates requiring updates:
    ✅ .specify/templates/plan-template.md — Constitution Check placeholder
       remains generic; gates enumerated in Development Workflow, available
       at plan-time via agent context. No file edit required.
    ✅ .specify/templates/spec-template.md — Scope/requirements structure is
       compatible with YAGNI and mobile-first constraints. No file edit required.
    ✅ .specify/templates/tasks-template.md — Task phases align with single-
       service architecture; no principle-driven task categories changed.
       No file edit required.
  Follow-up TODOs: None — all placeholders resolved.
-->

# ROMEU QUIZ Constitution

## Core Principles

### I. Mobile-First Participant Interfaces (NON-NEGOTIABLE)

Every UI element rendered to quiz participants MUST be designed for a mobile
viewport first. Desktop and tablet layouts are progressive enhancements only.

- Touch targets MUST be ≥ 48 × 48 px (WCAG 2.1 AA minimum).
- Layouts MUST be single-column on viewports ≤ 480 px with no horizontal scroll.
- No "desktop-only" shortcut is permitted for any participant-facing screen.
- Rationale: Participants join on personal phones during live sessions; a broken
  mobile experience collapses the product's core value proposition.

### II. Real-Time Responsiveness

Event delivery from server to all connected clients MUST complete within 100 ms
(p95) under the target concurrent-user load of a single live session.

- The server MUST push question state, scores, and results via WebSocket (or
  equivalent persistent connection); long-polling is prohibited.
- Any action affecting game state (next question, lock answers, reveal scores)
  MUST be reflected on all clients within the 100 ms budget.
- Rationale: Perceptible lag during answer windows destroys fairness and the
  live-event energy that is the product's primary value.

### III. Visual Clarity for Large-Screen Display

All host-projected content (scoreboard, question reveal, countdown) MUST be
legible from 10 meters on a standard projector or 60-inch display.

- Minimum font size for projected content: 48 px at 1080 p (scales proportionally).
- Color contrast ratio MUST be ≥ 4.5 : 1 for all text/background pairs.
- Animated transitions MUST complete in ≤ 400 ms and MUST NOT obscure data
  during the transition window.
- Rationale: The host display is the shared focal point in the training room;
  unreadable content invalidates the session for every participant simultaneously.

### IV. Minimal Infrastructure

The entire platform MUST run as a single Node.js process with SQLite as its
sole persistent-storage engine.

- No external databases (PostgreSQL, MySQL, Redis, etc.) are permitted.
- No separate worker processes, message queues, or microservices.
- All WebSocket handling is co-located in the same process as the HTTP API.
- SQLite WAL mode MUST be enabled to allow concurrent reads alongside writes.
- Rationale: Zero-ops deployment — the facilitator runs `node server.js` on a
  laptop with no cloud accounts, Docker, or configuration ceremony.

### V. YAGNI — Scope Locked to a Live Quiz Session

Only capabilities directly exercised during a live, facilitated quiz session
MAY be built.

- Feature requests outside the host–participant–projector triangle are deferred
  by default (analytics dashboards, persistent user accounts, third-party
  integrations, export pipelines, etc.).
- Every proposed addition MUST answer: "Is this required for a session to start,
  run, and end successfully?" A "no" answer means the feature is out of scope.
- Rationale: Scope creep is the primary delivery risk; the product is complete
  when a facilitator can run a session end-to-end without manual intervention.

## Technology Constraints

- **Runtime**: Node.js LTS — single process, single entrypoint file.
- **Persistence**: SQLite via `better-sqlite3`; WAL journal mode enabled; no
  ORM required.
- **Real-time transport**: WebSocket (`ws` library); Socket.IO is permitted only
  if it demonstrably simplifies implementation without adding infrastructure
  footprint.
- **Frontend**: Vanilla HTML/CSS/JS or a bundler-free lightweight approach for
  participant and host UIs. Heavy SPA frameworks (Next.js, Nuxt, etc.) are out
  of scope.
- **No mandatory build pipeline** for the server; a minimal client-side build
  step is acceptable provided it does not introduce a separate dev-server process.

## Development Workflow

- Each feature is specified before implementation; the spec MUST confirm
  alignment with all five Core Principles before any code is written.
- The Constitution Check in every plan MUST explicitly validate:
  1. Participant screens are designed mobile-first.
  2. Real-time event paths meet the 100 ms p95 budget.
  3. Host-projected views meet the large-screen legibility standards.
  4. No new infrastructure dependency is introduced.
  5. Scope is limited to live session needs (YAGNI).
- Pull requests that violate any Core Principle are rejected without exception.
- Testing is limited to what is explicitly requested in the feature spec, in
  keeping with Principle V (YAGNI).

## Governance

This constitution supersedes all other practices and conventions in the ROMEU
QUIZ project. Amendments follow the process below:

1. **Propose** — describe the principle change and its rationale.
2. **Review** — at least one other contributor MUST acknowledge the impact.
3. **Document** — update this file, increment the version per semver rules
   (MAJOR: principle removal or redefinition; MINOR: new section or principle;
   PATCH: clarification or wording fix), and set `Last Amended` to today's date.
4. **Propagate** — run `/speckit.constitution` to sync dependent templates;
   update any active specs or plans affected by the change.

All agents and contributors MUST consult this file before beginning any
implementation work.

**Version**: 1.0.0 | **Ratified**: 2026-03-19 | **Last Amended**: 2026-03-19
