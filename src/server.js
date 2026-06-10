const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const questions = require("./questions.json");
const { generateLeasePdf } = require("./pdfFiller");
const { getSuggestion } = require("./autofill");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// In-memory session store: { id: { answers: {}, index: 0, createdAt } }
const sessions = new Map();

const SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour
function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
setInterval(cleanupSessions, 1000 * 60 * 10).unref();

function buildMessage(session) {
  const idx = session.index;
  if (idx >= questions.length) {
    return { sessionId: session.id, done: true, message: "That's everything! Call GET /api/sessions/:id/pdf to retrieve the filled lease document." };
  }
  const q = questions[idx];
  const suggestion = getSuggestion(q.id, session.answers);

  let text = "";
  if (q.context) text += q.context + "\n\n";
  text += q.question;
  if (suggestion) {
    text += `\n\n(Based on your earlier answers, this looks like it should be ${suggestion}. Press enter / reply "yes" to accept, or type a different value.)`;
  }

  return {
    sessionId: session.id,
    done: false,
    fieldId: q.id,
    section: q.section,
    context: q.context,
    question: q.question,
    suggestedAnswer: suggestion,
    message: text,
    progress: { current: idx + 1, total: questions.length },
  };
}

// Start a new chatbot session
app.post("/api/sessions", (req, res) => {
  const id = randomUUID();
  const session = { id, answers: {}, index: 0, createdAt: Date.now() };
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

  const { answer } = req.body || {};
  if (session.index < questions.length) {
    const q = questions[session.index];
    let value = answer != null ? String(answer).trim() : "";

    // If the user accepts (or leaves blank) a question that has an
    // auto-computed suggestion, use the suggested value instead.
    const suggestion = getSuggestion(q.id, session.answers);
    if (suggestion && (value === "" || /^(y|yes|ok|okay|correct|same|accept)$/i.test(value))) {
      value = suggestion;
    }

    session.answers[q.id] = value;
    session.index += 1;
  }
  res.json(buildMessage(session));
});

// Retrieve all collected answers as JSON
app.get("/api/sessions/:id/answers", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ sessionId: session.id, answers: session.answers, complete: session.index >= questions.length });
});

// Generate and return the filled-in lease PDF
app.get("/api/sessions/:id/pdf", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const pdfBuffer = await generateLeasePdf(questions, session.answers);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="nj-lease-form-125-filled.pdf"');
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
app.listen(PORT, () => console.log(`NJ Lease Chatbot API listening on port ${PORT}`));
