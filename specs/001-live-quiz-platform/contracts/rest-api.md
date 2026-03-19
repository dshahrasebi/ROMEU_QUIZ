# REST API Contract

**Phase**: 1 | **Date**: 2026-03-19 | **Spec**: [spec.md](../spec.md)

All `/host/api/*` routes require a valid session cookie (`isHost: true`). Requests without a valid session return `401` (JSON) or redirect to `/host/login` depending on the `Accept` header. The login and logout routes are public.

Request bodies use `application/json` unless marked otherwise.

---

## Authentication

### GET /host/login
Serves the host login form HTML page. Public — no session required.

**Response 200**: HTML login page

---

### POST /host/login
Submit host password via HTML form.

**Content-Type**: `application/x-www-form-urlencoded`

| Field | Type | Required |
|-------|------|----------|
| `password` | string | yes |

**Responses**:
- `302 /host/` — login successful; signed `httpOnly` session cookie issued
- `302 /host/login?error=1` — invalid password

---

### POST /host/logout
Destroy the session and clear the cookie.

**Response**: `302 /host/login`

---

## Quiz Management

### GET /host/api/quizzes
List all saved quizzes with question count.

**Response 200**:
```json
[
  { "id": 1, "name": "Onboarding Q1 2026", "questionCount": 10, "createdAt": 1710800000000 },
  { "id": 2, "name": "Safety Training",    "questionCount": 5,  "createdAt": 1710810000000 }
]
```

---

### POST /host/api/quizzes
Create a new empty quiz.

**Request body**:
```json
{ "name": "My New Quiz" }
```

**Response 201**:
```json
{ "id": 3, "name": "My New Quiz", "createdAt": 1710820000000 }
```

**Response 400**:
```json
{ "error": "name is required" }
```

---

### GET /host/api/quizzes/:id
Return a quiz with all its questions ordered by `sort_order`.

**Response 200**:
```json
{
  "id": 1,
  "name": "Onboarding Q1 2026",
  "questions": [
    {
      "id": 5,
      "text": "What year was the company founded?",
      "options": ["2010", "2012", "2015", "2018"],
      "correctIndex": 1,
      "timeLimitSeconds": 20,
      "sortOrder": 0
    }
  ]
}
```

**Response 404**: `{ "error": "Quiz not found" }`

---

### PUT /host/api/quizzes/:id
Update quiz name.

**Request body**:
```json
{ "name": "Updated Quiz Name" }
```

**Response 200**: updated quiz object (without questions array)

**Response 404**: `{ "error": "Quiz not found" }`

---

### DELETE /host/api/quizzes/:id
Delete quiz and all its questions (cascade).

**Response 204**: no body

**Response 404**: `{ "error": "Quiz not found" }`

---

### POST /host/api/quizzes/:id/questions
Add a question to a quiz.

**Request body**:
```json
{
  "text": "What is the capital of France?",
  "options": ["London", "Paris", "Berlin", "Madrid"],
  "correctIndex": 1,
  "timeLimitSeconds": 20
}
```

**Response 201**:
```json
{
  "id": 12,
  "quizId": 1,
  "text": "What is the capital of France?",
  "options": ["London", "Paris", "Berlin", "Madrid"],
  "correctIndex": 1,
  "timeLimitSeconds": 20,
  "sortOrder": 3
}
```

**Response 400** (validation failure):
```json
{ "error": "options must be an array of exactly 4 non-empty strings" }
```

**Response 404**: `{ "error": "Quiz not found" }`

---

### PUT /host/api/questions/:id
Update a question. All fields are optional — only provided fields are updated.

**Request body** (all optional):
```json
{
  "text": "Updated question text?",
  "options": ["A", "B", "C", "D"],
  "correctIndex": 0,
  "timeLimitSeconds": 30
}
```

**Response 200**: updated question object

**Response 400**: validation error

**Response 404**: `{ "error": "Question not found" }`

---

### DELETE /host/api/questions/:id
Delete a single question.

**Response 204**: no body

**Response 404**: `{ "error": "Question not found" }`

---

## Session Control

### POST /host/api/session/start
Start a new live session from a saved quiz.

If a session is currently active (status ≠ `'ended'`), it is archived first: marked `'ended'` in SQLite and `game-ended` is emitted to all connected sockets on that session's room.

**Request body**:
```json
{ "quizId": 1 }
```

**Response 201**:
```json
{
  "sessionId": 7,
  "pin": "483920",
  "qrDataUrl": "data:image/png;base64,iVBORw0KGgo...",
  "quizName": "Onboarding Q1 2026",
  "questionCount": 10
}
```

**Response 400**:
```json
{ "error": "Quiz must have at least one question" }
```

**Response 404**: `{ "error": "Quiz not found" }`

---

### POST /host/api/session/reveal
Manually reveal the correct answer for the current question before the timer expires.

**No body required.**

Triggers `question-reveal` event to all sockets in `session:PIN`. Cancels the active question timer.

**Response 200**: `{ "status": "question-reveal", "questionIndex": 2 }`

**Response 400**: `{ "error": "No active question" }`

---

### POST /host/api/session/next
Advance the game. Behaviour depends on current `status`:

| Current status | Next status |
|----------------|------------|
| `lobby` | `question-active` (first question) |
| `question-active` | `question-reveal` (closes question early) |
| `question-reveal` | `leaderboard` |
| `leaderboard` | `question-active` (next question) or `ended` (if last question) |

**No body required.**

**Response 200**:
```json
{ "status": "question-active", "questionIndex": 2 }
```

**Response 400**: `{ "error": "No active session" }`

---

### POST /host/api/session/end
End the current session immediately from any state.

Emits `game-ended` with the final leaderboard to `session:PIN`.

**Response 200**: `{ "status": "ended" }`

**Response 400**: `{ "error": "No active session" }`

---

## Public (No Auth)

### GET /api/session/:pin
Check whether a PIN is valid and the session is joinable. Used by the player join page before showing the nickname form.

**Response 200**:
```json
{ "valid": true, "status": "lobby" }
```

**Response 404**:
```json
{ "valid": false, "error": "Session not found or has ended" }
```

---

### GET /health
Railway health check endpoint.

**Response 200**: `{ "status": "ok" }`
