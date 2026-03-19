# Socket.io Event Contract

**Phase**: 1 | **Date**: 2026-03-19 | **Spec**: [spec.md](../spec.md)

Transport: WebSocket. All events use the default `/` namespace.

## Rooms

| Room | Members | Purpose |
|------|---------|---------|
| `session:PIN` | host + display + all players | Game-wide broadcasts |
| `host:PIN` | host socket only | Host-exclusive updates (tally, state snapshot) |
| `display:PIN` | display socket only | Reserved for display-only events |
| Individual socket | one client | Personalised events (join result, answer confirmation) |

---

## Client → Server

### `join-lobby`
**Sender**: Player

Player requests to join an active session.

```json
{ "pin": "483920", "nickname": "Alice" }
```

**Server emits in response**:
- `join-success` to this socket on success
- `join-error` to this socket on failure

**Side effects on success**:
- Player record created in SQLite and in-memory `players` Map
- Socket joins room `session:PIN`
- `lobby-update` broadcast to `session:PIN`

---

### `host-join`
**Sender**: Host (requires valid session cookie `isHost: true`)

Host socket identifies itself for a session.

```json
{ "pin": "483920" }
```

**Server emits in response**: `host-state` to this socket

**Side effects**: Socket joins `session:PIN` and `host:PIN`

---

### `display-join`
**Sender**: Display view

Display view identifies itself for a session.

```json
{ "pin": "483920" }
```

**Server emits in response**: `display-state` to this socket

**Side effects**: Socket joins `session:PIN` and `display:PIN`

---

### `submit-answer`
**Sender**: Player

Player submits their chosen answer for the currently active question.

```json
{ "optionIndex": 2 }
```

**Preconditions**: Player must be in a `question-active` session and must not have previously submitted for this question index.

**Server emits in response**:
- `answer-accepted` to this socket
- `answer-tally-update` to `host:PIN`

**Side effects**:
- Submission stored in SQLite and in-memory `submissions` Map
- If all players connected have submitted, question closes automatically (equivalent to host calling reveal)

**Error cases**:
- Socket emits `answer-locked` if the question is no longer active

---

### `host-next`
**Sender**: Host socket (validated via `socket.request.session.isHost`)

Advance the game to the next logical state. See `POST /host/api/session/next` for state transition table.

**Payload**: none

**Side effects**: Appropriate event broadcast to `session:PIN`

---

### `host-reveal`
**Sender**: Host socket

Manually reveal the correct answer before the timer expires.

**Payload**: none

**Side effects**: Timer cancelled; `question-reveal` broadcast to `session:PIN`

---

### `host-end`
**Sender**: Host socket

End the game immediately.

**Payload**: none

**Side effects**: `game-ended` broadcast to `session:PIN`; session marked `ended` in SQLite

---

## Server → Client

### `join-success`
**To**: player socket

```json
{
  "playerId": 12,
  "nickname": "Alice",
  "playerCount": 8
}
```

---

### `join-error`
**To**: player socket

```json
{ "message": "Nickname already taken" }
```

Possible `message` values:
- `"Nickname must not be empty"`
- `"Nickname already taken"`
- `"Session not found"`
- `"Session is full"` (30-player limit reached)
- `"Session has already ended"`

---

### `lobby-update`
**To**: `session:PIN` room

Sent whenever a player joins the lobby.

```json
{
  "players": [
    { "nickname": "Alice" },
    { "nickname": "Bob" }
  ],
  "playerCount": 2
}
```

---

### `host-state`
**To**: host socket (on `host-join`)

Full state snapshot for the host panel. Used on initial connect and reconnect.

```json
{
  "sessionId": 7,
  "pin": "483920",
  "status": "lobby",
  "currentQuestionIndex": -1,
  "questionCount": 10,
  "quizName": "Onboarding Q1 2026",
  "qrDataUrl": "data:image/png;base64,...",
  "players": [
    { "nickname": "Alice", "score": 0, "connected": true }
  ]
}
```

---

### `display-state`
**To**: display socket (on `display-join`)

Full state snapshot for the projector view. Same shape as `host-state` with additional question data when `status === 'question-active'`:

```json
{
  "sessionId": 7,
  "pin": "483920",
  "status": "question-active",
  "currentQuestionIndex": 2,
  "questionCount": 10,
  "qrDataUrl": "data:image/png;base64,...",
  "currentQuestion": {
    "displayText": "What is the capital of France?",
    "timeLimitSeconds": 20,
    "options": ["London", "Paris", "Berlin", "Madrid"],
    "elapsedMs": 4200
  },
  "players": [ ... ]
}
```

**Note**: `correctIndex` is never included in display/player payloads while the question is active.

---

### `question-start`
**To**: `session:PIN` room

A new question is now active. Sent when the host advances from lobby or leaderboard.

```json
{
  "questionIndex": 0,
  "totalQuestions": 10,
  "displayText": "What is the capital of France?",
  "timeLimitSeconds": 20,
  "options": ["London", "Paris", "Berlin", "Madrid"]
}
```

`correctIndex` is intentionally omitted.

---

### `answer-tally-update`
**To**: `host:PIN` room only

Live count of answers per option as players submit. Sent after each submission.

```json
{
  "tally": [3, 7, 1, 2],
  "totalAnswered": 13,
  "totalPlayers": 18
}
```

`tally[i]` is the number of players who chose option index `i`.

---

### `answer-accepted`
**To**: individual player socket

```json
{ "optionIndex": 2 }
```

Player UI must lock all tiles immediately on receiving this event.

---

### `answer-locked`
**To**: individual player socket

Sent when a player tries to submit after the question has closed.

```json
{ "message": "Question is no longer accepting answers" }
```

---

### `question-reveal`
**To**: `session:PIN` room

Correct answer revealed, distribution shown, individual results available.

```json
{
  "questionIndex": 0,
  "correctIndex": 1,
  "tally": [3, 7, 1, 2],
  "playerResults": {
    "Alice": { "correct": true,  "pointsEarned": 872,  "newScore": 872  },
    "Bob":   { "correct": false, "pointsEarned": 0,    "newScore": 0    },
    "Carol": { "correct": true,  "pointsEarned": 1000, "newScore": 1000 }
  }
}
```

Each client uses `playerResults[ownNickname]` for personalised feedback. The display view uses the full `playerResults` map and `tally` to render distribution bars.

---

### `leaderboard-update`
**To**: `session:PIN` room

Between-question leaderboard. Sent after the host advances from `question-reveal`.

```json
{
  "leaderboard": [
    { "rank": 1, "nickname": "Carol", "score": 1000 },
    { "rank": 2, "nickname": "Alice", "score": 872  },
    { "rank": 3, "nickname": "Bob",   "score": 0    }
  ]
}
```

Top 10 players shown on display. Full list available in `game-ended`.

---

### `game-ended`
**To**: `session:PIN` room

Final game over. Triggers podium on display and final summary on all views.

```json
{
  "podium": [
    { "rank": 1, "nickname": "Carol", "score": 4250 },
    { "rank": 2, "nickname": "Alice", "score": 3800 },
    { "rank": 3, "nickname": "Bob",   "score": 3100 }
  ],
  "allPlayers": [
    { "rank": 1, "nickname": "Carol", "score": 4250 },
    { "rank": 2, "nickname": "Alice", "score": 3800 },
    { "rank": 3, "nickname": "Bob",   "score": 3100 },
    { "rank": 4, "nickname": "Dave",  "score": 2600 }
  ],
  "archived": false
}
```

`archived: true` is sent when a session is force-ended by starting a new session. Player/display views should show a "Session ended" screen instead of a podium when `archived === true`.

---

## Event Flow by Game Phase

```
LOBBY
  Player joins     → [player] join-lobby
                   ← [player]   join-success / join-error
                   ← [all]      lobby-update

QUESTION ACTIVE
  Host advances    → [host]   host-next (or REST POST /session/next)
                   ← [all]    question-start
  Player answers   → [player] submit-answer
                   ← [player]   answer-accepted
                   ← [host]     answer-tally-update

QUESTION REVEAL
  Timer expires OR host reveals
                   ← [all]    question-reveal

LEADERBOARD
  Host advances    → [host]   host-next
                   ← [all]    leaderboard-update

GAME ENDED
  Host ends / last question done
                   → [host]   host-end  (or REST POST /session/end)
                   ← [all]    game-ended
```
