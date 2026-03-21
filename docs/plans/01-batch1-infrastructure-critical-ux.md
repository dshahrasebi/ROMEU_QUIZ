# Batch 1 — Infrastructure + Critical UX

## 1.1 Railway Persistent Volume for SQLite

### Problem
Every Railway redeploy wipes the filesystem. `DATA_PATH=./data` is a temporary workaround — all quizzes, settings, history are lost on each deploy.

### Implementation

**Step 1 — Railway Dashboard: Create volume**
- Go to Railway project → service → Settings → Volumes
- Add volume: mount path = `/data`, size = 1 GB (free tier)
- This mounts a persistent disk at `/data` inside the container

**Step 2 — Update environment variable**
- Change `DATA_PATH` env var from `./data` to `/data`
- This aligns with the default in `src/db.js` line 6: `const DATA_PATH = process.env.DATA_PATH ?? '/data'`

**Step 3 — Ensure directory exists at startup**
- In `server.js`, before `require('./src/db')`, add:
  ```js
  const fs = require('fs');
  fs.mkdirSync(process.env.DATA_PATH || '/data', { recursive: true });
  ```
- This prevents crashes if the volume mount point doesn't pre-exist

**Step 4 — Remove the `./data` workaround from Railway env vars**

### Files modified
- `server.js` — add `fs.mkdirSync` before db import (~line 22)
- Railway Dashboard — volume config + env var update

### Verification
1. Deploy to Railway
2. Create a quiz, add questions
3. Trigger a redeploy (push an empty commit)
4. Verify quiz still exists after redeploy

---

## 1.2 Player "Waiting..." State After Answering

### Problem
After tapping an answer, tiles lock/fade but there's no reassuring message. Players wonder if their answer registered.

### Current behavior
- `public/play/index.html` line 588: click handler calls `lockTiles()` + emits `submit-answer`
- `lockTiles()` (line 599): dims unselected tiles, highlights selected, adds `answered` class
- No text feedback shown — player stares at dimmed tiles until reveal

### Implementation

**Step 1 — Add a hidden "Locked in!" overlay to question screen HTML**
- In `public/play/index.html`, inside `#screen-question` (line 167), add a hidden div after the tile grid:
  ```html
  <div id="answer-locked-msg" class="hidden text-center mt-4">
    <p class="text-2xl font-black" data-i18n="play.locked_in">✅ Locked in!</p>
    <p class="text-white/50 text-sm mt-1" data-i18n="play.waiting_reveal">Waiting for reveal...</p>
  </div>
  ```

**Step 2 — Show the message after submitting**
- In the click handler (line 588), after `lockTiles()`, add:
  ```js
  document.getElementById('answer-locked-msg').classList.remove('hidden');
  ```

**Step 3 — Hide the message when a new question starts**
- In the `question-start` handler (line 455), add:
  ```js
  document.getElementById('answer-locked-msg').classList.add('hidden');
  ```

**Step 4 — Add i18n keys**
- In `public/i18n.js`, add to both `en` and `es` dictionaries:
  - `play.locked_in` → "✅ Locked in!" / "✅ ¡Registrado!"
  - `play.waiting_reveal` → "Waiting for reveal..." / "Esperando resultado..."

### Files modified
- `public/play/index.html` — HTML + JS (3 small changes)
- `public/i18n.js` — 2 new keys × 2 languages

### Verification
1. Join a game, submit an answer
2. Confirm "Locked in!" message appears immediately
3. Confirm it disappears when the next question starts
4. Test in Spanish locale

---

## 1.3 Streak Count Visible on Player Phone

### Problem
Streak bonuses are computed and awarded (3x=100pts, 5x=200pts) but the player only sees bonus points, not "3 in a row!" context. The `streak` field is already in the reveal payload (`gameManager.js` line 369) but the player UI ignores it.

### Current behavior
- Server emits `playerResults[nickname].streak` (integer) in `question-reveal`
- `public/play/index.html` line 531: only checks `bonusPoints > 0`, shows "🔥 +{pts} streak bonus"
- The `#feedback-streak` div (line 220) is hidden when bonusPoints is 0, even if streak is 2

### Implementation

**Step 1 — Update the streak display logic in play/index.html**
- Replace the bonusPoints-only check (line 531-536) with:
  ```js
  const streakEl = document.getElementById('feedback-streak');
  const streak = myResult?.streak || 0;
  if (streak >= 2) {
    let streakText = t('play.streak_count', { count: streak });
    if (myResult.bonusPoints > 0) {
      streakText += ' ' + t('play.streak_bonus', { pts: myResult.bonusPoints });
    }
    streakEl.textContent = streakText;
    streakEl.classList.remove('hidden');
  } else {
    streakEl.classList.add('hidden');
  }
  ```

**Step 2 — Add i18n keys**
- `play.streak_count` → "🔥 {count} in a row!" / "🔥 ¡{count} seguidas!"
- Update existing `play.streak_bonus` to just the bonus part: "+{pts} bonus"

### Files modified
- `public/play/index.html` — ~6 lines in reveal handler
- `public/i18n.js` — 1 new key + 1 updated key × 2 languages

### Verification
1. Play a game, get 2 correct in a row → see "🔥 2 in a row!" (no bonus yet)
2. Get 3rd correct → see "🔥 3 in a row! +100 bonus"
3. Get one wrong → streak display hidden
4. Test in Spanish

---

## 1.4 Host Kick Player

### Problem
No way to remove a disruptive player from a live session. The host must tolerate them or end the entire game.

### Current architecture
- Players stored in `state.players` Map (socketId → {playerId, nickname, score, streak, connected})
- `lobby-update` emitted to session room with player list (socketHandlers.js line 283)
- Disconnect marks `connected=false` in DB and state (socketHandlers.js line 327)
- No kick event exists

### Implementation

**Step 1 — Add `host-kick` socket event handler in socketHandlers.js**
- After the `host-reveal` handler (~line 153), add:
  ```js
  socket.on('host-kick', ({ pin, nickname } = {}) => {
    if (!socket.request.session?.isHost) {
      return socket.emit('error', { message: t('sock.unauthorized') });
    }
    const state = gameManager.getState();
    if (!state || state.pin !== pin) return;

    // Find the player by nickname
    let targetSocketId = null;
    for (const [sid, p] of state.players.entries()) {
      if (p.nickname === nickname) { targetSocketId = sid; break; }
    }
    if (!targetSocketId) return;

    const player = state.players.get(targetSocketId);
    // Remove from game state
    state.players.delete(targetSocketId);
    // Mark disconnected in DB
    db.setPlayerConnected(player.playerId, false);

    // Notify the kicked player's socket
    const kickedSocket = io.sockets.sockets.get(targetSocketId);
    if (kickedSocket) {
      kickedSocket.emit('kicked', { message: t('sock.you_were_kicked') });
      kickedSocket.leave(`session:${pin}`);
      kickedSocket.disconnect(true);
    }

    // Update lobby for everyone
    io.to(`session:${pin}`).emit('lobby-update', {
      players: Array.from(state.players.values()).map(p => ({ nickname: p.nickname })),
      playerCount: Array.from(state.players.values()).filter(p => p.connected).length,
    });
  });
  ```

**Step 2 — Add kick button to host UI lobby player list**
- In `public/host/index.html`, the lobby player list rendering (in the socket `lobby-update` handler or `host-state` handler) should show a ✕ button next to each player nickname
- Clicking emits: `socket.emit('host-kick', { pin: currentPin, nickname: playerName })`

**Step 3 — Add kicked screen to player page**
- In `public/play/index.html`, add a `#screen-kicked` div with "You were removed from the game" message
- Add socket listener: `socket.on('kicked', () => showScreen('screen-kicked'))`

**Step 4 — Prevent kicked player from rejoining**
- In the `player-join` handler (socketHandlers.js line 217), check if nickname matches a kicked player
- Add a `kickedNicknames` Set to the game state, populated on kick
- Block rejoin with error: `t('sock.kicked_cannot_rejoin')`

**Step 5 — Add i18n keys**
- `sock.you_were_kicked`, `sock.kicked_cannot_rejoin`, `play.kicked_title`, `play.kicked_msg`, `host.btn_kick`

### Files modified
- `src/socketHandlers.js` — new `host-kick` event handler + rejoin guard
- `src/gameManager.js` — add `kickedNicknames: new Set()` to state
- `public/host/index.html` — kick button in player list
- `public/play/index.html` — kicked screen + socket listener
- `public/i18n.js` — 5 new keys × 2 languages
- `src/i18n-server.js` — 2 new server-side keys × 2 languages

### Verification
1. Start a game, have 2 players join
2. Host kicks player A → player A sees "removed" screen, cannot rejoin
3. Player B is unaffected, lobby count updates
4. Kicked player trying to rejoin with same nickname gets error
5. Game continues normally without kicked player
