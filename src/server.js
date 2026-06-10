const express = require("express");
const path = require("path");
const multer = require("multer");
const { randomUUID } = require("crypto");
const { analyzePdf } = require("./pdfForm");
const { fillPdf } = require("./pdfFiller");
const { getSuggestion } = require("./autofill");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// formId -> { buffer, mode, fields, name, createdAt }
const forms = new Map();
// sessionId -> { id, formId, answers, index, confirmed, createdAt }
const sessions = new Map();

const TTL_MS = 1000 * 60 * 60; // 1 hour
function cleanup() {
  const now = Date.now();
  for (const [id, f] of forms) if (now - f.createdAt > TTL_MS) forms.delete(id);
  for (const [id, s] of sessions) if (now - s.createdAt > TTL_MS) sessions.delete(id);
}
setInterval(cleanup, 1000 * 60 * 10).unref();

function buildSummary(session, fields) {
  return fields.map((f) => ({
    fieldId: f.id,
    section: f.label || f.name || "",
    question: f.question,
    answer: session.answers[f.id] || "",
  }));
}

function buildMessage(session) {
  const form = forms.get(session.formId);
  if (!form) return { sessionId: session.id, error: "Form expired or not found" };
  const fields = form.questionFields;
  const idx = session.index;

  if (idx >= fields.length) {
    if (!session.confirmed) {
      return {
        sessionId: session.id,
        done: false,
        needsConfirmation: true,
        message:
          "That's everything! Please review your answers below. " +
          'If everything looks correct, POST to /api/sessions/:id/confirm with {"confirm": true} to generate the PDF. ' +
          'To change an answer first, POST {"fieldId": "...", "answer": "..."}.',
        summary: buildSummary(session, fields),
      };
    }
    return { sessionId: session.id, done: true, message: "Confirmed! Call GET /api/sessions/:id/pdf to retrieve the filled PDF." };
  }

  const f = fields[idx];
  const suggestion = getSuggestion(f, fields, session.answers);

  let text = "";
  if (f.context) text += f.context + "\n\n";
  text += f.question;
  if (suggestion) {
    text += `\n\n(Based on your earlier answers, this looks like it should be ${suggestion}. Press enter / reply "yes" to accept, or type a different value.)`;
  }

  return {
    sessionId: session.id,
    done: false,
    fieldId: f.id,
    section: f.label || f.name || "",
    context: f.context,
    question: f.question,
    options: f.options || null,
    suggestedAnswer: suggestion,
    message: text,
    progress: { current: idx + 1, total: fields.length },
  };
}

// Upload a PDF form to be analyzed
app.post("/api/forms", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
  try {
    const { mode, fields } = await analyzePdf(req.file.buffer);
    if (fields.length === 0) {
      return res.status(422).json({ error: "No fillable fields or blanks could be found in this PDF" });
    }
    const questionFields = fields.filter((f) => !f.linkedTo);
    const formId = randomUUID();
    forms.set(formId, { buffer: req.file.buffer, mode, fields, questionFields, name: req.file.originalname, createdAt: Date.now() });
    res.json({ formId, mode, fieldCount: questionFields.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to analyze PDF" });
  }
});

// Start a new chatbot session for an uploaded form
app.post("/api/forms/:formId/sessions", (req, res) => {
  const form = forms.get(req.params.formId);
  if (!form) return res.status(404).json({ error: "Form not found (it may have expired - re-upload)" });

  const id = randomUUID();
  const session = { id, formId: req.params.formId, answers: {}, index: 0, createdAt: Date.now() };
  sessions.set(id, session);
  res.json(buildMessage(session));
});

// Get current question state
app.get("/api/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(buildMessage(session));
});

// Submit an answer, get next question
app.post("/api/sessions/:id/answer", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const form = forms.get(session.formId);
  if (!form) return res.status(404).json({ error: "Form expired or not found" });

  const { answer } = req.body || {};
  if (session.index < form.questionFields.length) {
    const f = form.questionFields[session.index];
    let value = answer != null ? String(answer).trim() : "";

    const suggestion = getSuggestion(f, form.questionFields, session.answers);
    if (suggestion && (value === "" || /^(y|yes|ok|okay|correct|same|accept)$/i.test(value))) {
      value = suggestion;
    }

    session.answers[f.id] = value;
    session.index += 1;
  }
  res.json(buildMessage(session));
});

// Review/confirm step: edit an answer, or confirm to allow PDF generation
app.post("/api/sessions/:id/confirm", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const form = forms.get(session.formId);
  if (!form) return res.status(404).json({ error: "Form expired or not found" });
  if (session.index < form.questionFields.length) {
    return res.status(400).json({ error: "All questions must be answered before confirming" });
  }

  const { confirm, fieldId, answer } = req.body || {};

  if (fieldId !== undefined) {
    const valid = form.questionFields.find((f) => f.id === fieldId);
    if (!valid) return res.status(400).json({ error: `Unknown fieldId: ${fieldId}` });
    session.answers[fieldId] = answer != null ? String(answer).trim() : "";
    session.confirmed = false;
  } else if (confirm) {
    session.confirmed = true;
  }

  res.json(buildMessage(session));
});

// Retrieve all collected answers as JSON
app.get("/api/sessions/:id/answers", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const form = forms.get(session.formId);
  res.json({ sessionId: session.id, answers: session.answers, complete: form ? session.index >= form.questionFields.length : false });
});

// Generate and return the filled-in PDF
app.get("/api/sessions/:id/pdf", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const form = forms.get(session.formId);
  if (!form) return res.status(404).json({ error: "Form expired or not found" });
  if (session.index < form.questionFields.length || !session.confirmed) {
    return res.status(400).json({ error: "Session not yet confirmed. POST to /api/sessions/:id/confirm first." });
  }

  try {
    const answers = { ...session.answers };
    for (const f of form.fields) {
      if (f.linkedTo) answers[f.id] = answers[f.linkedTo];
    }
    const pdfBuffer = await fillPdf(form.buffer, form.mode, form.fields, answers);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="filled-form.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// Reset/delete a session
app.delete("/api/sessions/:id", (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF Form Chatbot API listening on port ${PORT}`));
