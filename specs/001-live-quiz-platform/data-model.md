# Data Model: Live Audience Quiz Platform

**Phase**: 1 | **Date**: 2026-03-19 | **Spec**: [spec.md](spec.md)

---

## Entities

### Quiz

A named collection of questions created and owned by the host. Persists independently of any session.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | |
| `name` | TEXT | NOT NULL | Display name shown in quiz library |
| `created_at` | INTEGER | NOT NULL | Unix timestamp (ms) |

**Validation rules**:
- `name` must be 1–100 non-empty characters
- No uniqueness constraint on name (hosts may have multiple quizzes with similar names)

---

### Question

A single multiple-choice item within a quiz. Always has exactly 4 answer options.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | |
| `quiz_id` | INTEGER | NOT NULL, FK → quizzes.id ON DELETE CASCADE | |
| `text` | TEXT | NOT NULL | The question prompt |
| `options` | TEXT | NOT NULL | JSON array of exactly 4 strings: `["A","B","C","D"]` |
| `correct_index` | INTEGER | NOT NULL, CHECK (0–3) | 0-based index into options array |
| `time_limit_seconds` | INTEGER | NOT NULL, DEFAULT 20, CHECK (5–120) | Per-question configurable timer |
| `sort_order` | INTEGER | NOT NULL, DEFAULT 0 | Ascending display order within quiz |

**Validation rules**:
- `options` must deserialize to a JSON array of exactly 4 non-empty strings
- `correct_index` must be 0, 1, 2, or 3
- `time_limit_seconds` must be between 5 and 120 inclusive

**Answer option layout** (always in this color order):
| Index | Color | Shape |
|-------|-------|-------|
| 0 | Red `#E21B3C` | Triangle |
| 1 | Blue `#1368CE` | Diamond |
| 2 | Yellow `#D89E00` | Circle |
| 3 | Green `#26890C` | Square |

---

### Session

An instance of a live game run from a saved quiz.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | |
| `pin` | TEXT | NOT NULL, UNIQUE | 6-digit zero-padded numeric string, e.g. `"048392"` |
| `quiz_id` | INTEGER | NOT NULL, FK → quizzes.id | Source quiz; questions copied into `state_json` at start |
| `status` | TEXT | NOT NULL, DEFAULT `'lobby'`, CHECK (see transitions) | Current game phase |
| `current_question_index` | INTEGER | NOT NULL, DEFAULT 0 | 0-based; -1 when in lobby before first question |
| `state_json` | TEXT | NULL | Full serialized game state for crash resilience |
| `started_at` | INTEGER | NOT NULL | Unix timestamp (ms) |
| `ended_at` | INTEGER | NULL | Set when status transitions to `'ended'` |

**Status allowed values**: `lobby`, `question-active`, `question-reveal`, `leaderboard`, `ended`

**State transitions**:
```
lobby
  └─► question-active ─► question-reveal ─► leaderboard ─► question-active  (repeats)
                                                        └─► ended            (final question done)
lobby ─────────────────────────────────────────────────────────────────► ended  (host ends early)
question-active ────────────────────────────────────────────────────────► ended  (host ends early)
question-reveal ────────────────────────────────────────────────────────► ended  (host ends early)
leaderboard ────────────────────────────────────────────────────────────► ended  (host ends early)
```

**PIN generation**: `Math.floor(100000 + Math.random() * 900000).toString()` — ensures 6-digit range. Check for collision against existing active sessions before use (retry if collision, practically impossible).

---

### Player

A participant in a specific session. Identified by `nickname` within the session scope.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | |
| `session_id` | INTEGER | NOT NULL, FK → sessions.id | |
| `nickname` | TEXT | NOT NULL | Case-preserved, UNIQUE per session (COLLATE NOCASE) |
| `score` | INTEGER | NOT NULL, DEFAULT 0 | Cumulative score across all answered questions |
| `connected` | INTEGER | NOT NULL, DEFAULT 1 | Boolean 0/1; updated on socket disconnect/reconnect |
| `socket_id` | TEXT | NULL | Current Socket.io socket ID; updated on reconnect |

**UNIQUE constraint**: `UNIQUE(session_id, nickname COLLATE NOCASE)` — enforced at both application and DB level.

**Validation rules**:
- `nickname` trimmed, 1–20 characters, no leading/trailing whitespace
- Uniqueness check is case-insensitive at join time; nickname stored with original casing

---

### Answer Submission

One player's response to one question within a session.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | |
| `session_id` | INTEGER | NOT NULL, FK → sessions.id | Denormalized for fast per-question queries |
| `player_id` | INTEGER | NOT NULL, FK → players.id | |
| `question_id` | INTEGER | NOT NULL, FK → questions.id | |
| `option_index` | INTEGER | NOT NULL, CHECK (0–3) | Player's chosen option |
| `elapsed_ms` | INTEGER | NOT NULL | Milliseconds from `question-start` event to submission |
| `points_earned` | INTEGER | NOT NULL, DEFAULT 0 | Score for this submission (0 if wrong; 500–1000 if correct) |

**UNIQUE constraint**: `UNIQUE(session_id, player_id, question_id)` — one answer per player per question; prevents re-submission.

---

## SQLite Schema (DDL)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quizzes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id            INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  text               TEXT    NOT NULL,
  options            TEXT    NOT NULL,  -- JSON: ["opt0","opt1","opt2","opt3"]
  correct_index      INTEGER NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  time_limit_seconds INTEGER NOT NULL DEFAULT 20 CHECK (time_limit_seconds BETWEEN 5 AND 120),
  sort_order         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, sort_order);

CREATE TABLE IF NOT EXISTS sessions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  pin                    TEXT    NOT NULL UNIQUE,
  quiz_id                INTEGER NOT NULL REFERENCES quizzes(id),
  status                 TEXT    NOT NULL DEFAULT 'lobby'
                           CHECK (status IN ('lobby','question-active','question-reveal','leaderboard','ended')),
  current_question_index INTEGER NOT NULL DEFAULT 0,
  state_json             TEXT,
  started_at             INTEGER NOT NULL,
  ended_at               INTEGER
);

CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  nickname   TEXT    NOT NULL,
  score      INTEGER NOT NULL DEFAULT 0,
  connected  INTEGER NOT NULL DEFAULT 1,
  socket_id  TEXT,
  UNIQUE (session_id, nickname COLLATE NOCASE)
);

CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_id);

CREATE TABLE IF NOT EXISTS answer_submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  player_id     INTEGER NOT NULL REFERENCES players(id),
  question_id   INTEGER NOT NULL REFERENCES questions(id),
  option_index  INTEGER NOT NULL CHECK (option_index BETWEEN 0 AND 3),
  elapsed_ms    INTEGER NOT NULL,
  points_earned INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, player_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_session_question
  ON answer_submissions(session_id, question_id);
```

---

## In-Memory Game State (gameManager.js)

The active game is held in a JavaScript object — the source of truth during a live session. SQLite `state_json` is the backup; it is written on every state transition.

```js
// Shape of the active game object (never null when a session is running)
{
  sessionId: number,
  pin: string,                    // "483920"
  quizId: number,
  questions: Array<{
    id: number,
    text: string,
    options: string[],            // 4 elements, index matches color/shape above
    correctIndex: number,
    timeLimitSeconds: number,
    sortOrder: number
  }>,
  currentQuestionIndex: number,   // -1 = lobby (before first question)
  status: 'lobby' | 'question-active' | 'question-reveal' | 'leaderboard' | 'ended',
  players: Map<number, {          // keyed by player.id
    id: number,
    nickname: string,
    score: number,
    connected: boolean,
    socketId: string | null
  }>,
  submissions: Map<number, Map<number, {  // [questionId][playerId]
    optionIndex: number,
    elapsedMs: number,
    pointsEarned: number
  }>>,
  questionStartTime: number | null,       // Date.now() when question went active
  questionTimer: NodeJS.Timeout | null,   // reference for clearTimeout on manual advance
  qrDataUrl: string                       // base64 PNG produced at session start
}
```

---

## Scoring Formula

```
points = Math.round(500 + 500 × max(0, (time_limit_ms − elapsed_ms) / time_limit_ms))
```

| Scenario | Points |
|----------|--------|
| Correct answer, elapsed ≈ 0 ms | **1000** |
| Correct answer, elapsed = half time limit | **750** |
| Correct answer, elapsed ≈ time limit | **~500** |
| Incorrect answer | **0** |
| No answer submitted | **0** |

Player `score` in SQLite and in-memory is incremented atomically after each `question-reveal` transition.

---

## Key Relationships

```
quizzes 1──* questions
quizzes 1──* sessions
sessions 1──* players
sessions 1──* answer_submissions
players 1──* answer_submissions
questions 1──* answer_submissions
```
