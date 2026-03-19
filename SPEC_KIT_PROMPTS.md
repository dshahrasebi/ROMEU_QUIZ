# Spec Kit Prompts — ROMEU QUIZ

> **How to use:** Open GitHub Copilot Chat in VS Code in **Agent mode**.  
> Run each command in order. Copy the prompt text and paste it immediately  
> after the slash command (e.g. `/speckit.constitution Create principles focused on...`).

---

## STEP 1 — `/speckit.constitution`

**Run this first.** Sets the governing principles that guide all subsequent steps.

**Prompt:**

```
Create principles focused on: mobile-first design as
non-negotiable for participant interfaces; real-time
responsiveness (sub-100ms event delivery); visual
clarity for large-screen display (readable from 10+
meters); rapid delivery with minimal infrastructure
(single Node.js service, SQLite for persistence);
YAGNI — only build what is needed for a live
interactive quiz session.
```

**What to expect:** Copilot generates `.specify/memory/constitution.md`.  
Review it and ask Copilot to adjust any principle before moving on.

---

## STEP 2 — `/speckit.specify`

**Run after constitution is approved.** Produces the full requirements document.

**Prompt:**

```
Build a real-time audience quiz platform (Kahoot-style)
for live training sessions. The visual experience must
be production-quality and indistinguishable from Kahoot
in screenshots.

Three interfaces:

(1) HOST admin panel — create, edit, and delete multiple
quizzes each containing multiple-choice questions with
configurable time limits per question; select any saved
quiz and start a live game session that generates a
6-digit PIN and a QR code; control question progression
manually (next question button); see live response counts
per answer option as players respond.

(2) DISPLAY view on projector or large screen — deep
violet radial gradient background (#46178F to #8B2FC9);
join screen shows a large QR code and the 6-digit PIN
prominently; each question displayed in 72px+ bold font
centered on screen; SVG animated countdown ring that
visually drains over the question duration; after each
question reveal the correct answer and show animated
answer distribution bars; animated staggered leaderboard
between questions; final podium screen with top-3 players
where columns animate upward from zero height.

(3) PLAYER view on mobile phones — mobile-first
single-column full-height layout; join by scanning QR
or manually entering PIN; enter a nickname; live lobby
screen showing joined player count with player chips
popping in as they connect; 4 large colored answer tiles
occupying 50% of the viewport height with Kahoot
signature shapes (red with triangle, blue with diamond,
yellow with circle, green with square); tiles are
disabled immediately after tapping and visually show
the selected state; animated correct/wrong feedback
(large green checkmark or red X scaling in with a
spring animation); current score displayed with a
counting-up bounce animation and current rank shown
after each question; final podium screen at game end.

Scoring: correct answers earn points inversely
proportional to response time (faster = more points);
wrong or no answer earns zero points.

Multiple quizzes are stored persistently so the host
can run different quizzes throughout a training session
without re-entering questions.
```

**What to expect:** Copilot generates a feature spec document under `.specify/features/`.  
Review for completeness before proceeding.

---

## STEP 3 (Optional but Recommended) — `/speckit.clarify`

**Run after specify.** Copilot asks clarifying questions to catch ambiguities.  
**Run this live during your training demo** — it's a compelling Spec Kit moment  
to show the audience how AI surfaces requirements gaps you hadn't thought of.

**Prompt:** *(no extra text — just run the command)*

```
/speckit.clarify
```

Answer Copilot's questions conversationally. The answers get folded back into the spec.

---

## STEP 4 — `/speckit.plan`

**Run after spec (and clarify) are complete.** Produces the technical implementation plan.

**Prompt:**

```
Use Node.js with Express and Socket.io for real-time
communication. Frontend: plain HTML/CSS/JS — no build
tools or frameworks. Tailwind CSS loaded via CDN for
layout and utilities.

Custom CSS file (public/shared.css) must define:
  1. CSS custom properties for the full design system:
     background radial gradient #46178F→#8B2FC9,
     answer colors Red #E21B3C / Blue #1368CE /
     Yellow #D89E00 / Green #26890C
  2. SVG animated countdown ring via stroke-dashoffset
     driven by a CSS variable set from JavaScript
  3. Answer tile press state via scale(0.96) transform
     and color flash on tap
  4. Score counter @keyframes cubic-bezier bounce
     animation
  5. Correct/wrong feedback spring scale-in animation
  6. Leaderboard row staggered slide-in with
     animation-delay per rank
  7. Podium column height-from-zero animation
  8. CSS confetti (30 positioned divs, random
     @keyframes scatter) triggered on correct answer

Typography: Google Fonts Nunito 700 and 900.

All player-facing screens must be visually
indistinguishable from Kahoot.

QR codes generated server-side using the 'qrcode' npm
package pointing to the Railway public URL +
/play?pin=XXXXXX. Quizzes and questions persisted in
SQLite using better-sqlite3 stored at /data/quiz.db.
One active game at a time held in memory. Host admin
panel protected by a HOST_PASSWORD environment variable.

File structure:
  - server.js (Express + Socket.io entrypoint)
  - src/db.js (SQLite init and quiz CRUD)
  - src/gameManager.js (active game state and scoring)
  - src/socketHandlers.js (Socket.io event wiring)
  - public/shared.css (full design system and animations)
  - public/host/index.html (admin + game control)
  - public/display/index.html (projector view)
  - public/play/index.html (phone player view)

Deploy to Railway as a single Node.js service. Add a
Railway volume mounted at /data for SQLite persistence.
Include railway.toml and .env.example. Attendees
connect from the internet via the Railway public URL.
```

**What to expect:** Copilot generates a detailed plan document.  
Review the architecture section, file structure, and Socket.io event list.

---

## STEP 5 — `/speckit.tasks`

**Run after plan is reviewed.** Breaks the plan into an ordered task list.

**Prompt:** *(no extra text — just run the command)*

```
/speckit.tasks
```

**What to expect:** Copilot generates a numbered task list.  
Scan for logical order — database setup should come before game logic,  
which should come before frontend. Adjust if anything looks out of sequence.

---

## STEP 6 — `/speckit.implement`

**Run after task list is approved.** Executes all tasks and generates the code.

**Prompt:** *(no extra text — just run the command)*

```
/speckit.implement
```

**What to expect:** Copilot implements each task sequentially, creating all files.  
This may take several minutes. Let it complete fully before reviewing output.

---

## POST-IMPLEMENTATION: Visual QA Checklist

After `/speckit.implement` completes, open each view and verify:

### Display view (`/display`)
- [ ] Deep violet radial gradient background visible
- [ ] Countdown ring animates and drains in real time
- [ ] Question text is large (72px+) and centered
- [ ] Leaderboard rows slide in with stagger delay

### Player view (`/play`) — test on a real phone
- [ ] 4 colored tiles fill most of the screen
- [ ] Shapes visible on each tile (▲ ◆ ● ■)
- [ ] Tile disables and shows selected state immediately after tap
- [ ] Correct/wrong animation plays
- [ ] Score counts up with bounce

### Host view (`/host`)
- [ ] Can create a quiz with multiple questions
- [ ] Quizzes persist after server restart
- [ ] QR code displays and links to correct player URL

### Quick fixes for common issues

**Countdown ring not animating:**
```
The SVG countdown ring is not animating. Implement
stroke-dashoffset animation using a CSS variable
--ring-progress updated via JavaScript
requestAnimationFrame over the question duration.
```

**Tiles not filling the screen on mobile:**
```
The answer tiles on the player view are not filling
the screen on mobile. Make the 4-tile grid occupy
100vw and 50vh total, with each tile being 50% width
and 50% height of that grid.
```

**Confetti missing:**
```
Implement the CSS confetti animation — 30 absolutely
positioned divs scattering from the center of the
screen using random @keyframes translate and rotate,
triggered by adding a .confetti-active class to a
container div.
```

---

## DEPLOYMENT CHECKLIST (Railway)

1. `npm install -g @railway/cli`
2. `railway login`
3. `railway init` — link to your GitHub repo
4. Set environment variables in Railway dashboard:
   - `HOST_PASSWORD` = your chosen password
   - `NODE_ENV` = `production`
   - `PORT` = `3000`
5. Add a Railway volume → mount path: `/data`
6. Push to GitHub → Railway auto-deploys
7. Get your public URL from the Railway dashboard
8. Open `<RAILWAY_URL>/display` on the projector browser
9. Open `<RAILWAY_URL>/host` on your laptop
10. Test QR code scan with your phone over **mobile data** (not WiFi)

---

*Generated with Spec Kit v0.3.1 · GitHub Copilot · March 2026*
