# PDF Form Chatbot

Upload any PDF form (lease, application, contract, etc). The API analyzes it,
then a chatbot asks one question per blank or fillable field — showing the
surrounding text/context for each one — and finally returns the original PDF
with your answers filled in.

Two modes, chosen automatically:
- **acroform** — the PDF has real fillable form fields (text/checkbox/radio/dropdown).
  Answers are written into those fields and the form is flattened.
- **blanks** — the PDF is flattened/scanned text with literal `______` blanks.
  Each blank's position is located on the page and the answer is drawn there.

**Smart auto-fill:** if a field looks like a lease/term "end date" and you've
already answered a "start date" and a "term length" (e.g. "12 months"), the
end date is computed automatically and offered as a suggestion (just press
enter / reply "yes" to accept).

## Endpoints

- `POST /api/forms` — multipart upload, field name `file` (a PDF). Returns `{ formId, mode, fieldCount }`.
- `POST /api/forms/:formId/sessions` — start a new chatbot session for that form. Returns the first question.
- `GET /api/sessions/:id` — get the current question/state for a session.
- `POST /api/sessions/:id/answer` — body `{ "answer": "..." }`. Submits the answer and returns the next question.
- `GET /api/sessions/:id/answers` — returns all collected answers as JSON.
- `POST /api/sessions/:id/confirm` — body `{ "confirm": true }` after all questions are answered, or `{ "fieldId": "...", "answer": "..." }` to edit an answer.
- `GET /api/sessions/:id/pdf` — generates and returns the filled-in PDF.
- `DELETE /api/sessions/:id` — deletes a session.
- `GET /health` — health check.

Forms and sessions are kept in memory for 1 hour.

## Test interface

A browser UI is served at `/` — upload a PDF and chat through the form locally.

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000
