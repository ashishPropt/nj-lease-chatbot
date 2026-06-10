# NJ Lease Chatbot API

Node.js/Express API that drives a question-by-question chatbot to fill out the
NJ REALTORS Form 125 Residential Lease, then returns a completed PDF.

## Endpoints

- `POST /api/sessions` — start a new chatbot session. Returns the first question.
- `GET /api/sessions/:id` — get the current question/state for a session.
- `POST /api/sessions/:id/answer` — body `{ "answer": "..." }`. Submits the answer to the current question and returns the next one.
- `GET /api/sessions/:id/answers` — returns all collected answers as JSON.
- `GET /api/sessions/:id/pdf` — generates and returns the filled lease PDF.
- `DELETE /api/sessions/:id` — deletes a session.
- `GET /health` — health check.

## Test interface

A simple browser chatbot UI is served at `/` for local testing.

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000
