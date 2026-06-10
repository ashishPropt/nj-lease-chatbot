// Analyzes an uploaded PDF and produces a flat list of "fields" to ask the
// user about, plus enough info to fill the answers back into the PDF.
//
// Two modes:
//  - "acroform": the PDF has real AcroForm fields (text/checkbox/radio/dropdown).
//    We ask one question per field.
//  - "blanks": the PDF is a flattened/scanned-but-text form with literal
//    underscore blanks ("______"). We locate each blank's position on the
//    page (via pdf.js text positions) so we can later draw the answer there.

const { PDFDocument } = require("pdf-lib");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const BLANK_RE = /_{3,}/g;

function cleanLabel(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Build a short, natural question from the words immediately surrounding a
// blank, without just echoing the whole line back at the user.
function buildQuestion(before, after) {
  const b = cleanLabel(before).slice(-80).replace(/^[\s,.;:()]+|[\s,.;:]+$/g, "");
  const a = cleanLabel(after).slice(0, 60).replace(/^[\s,.;:]+|[\s,.;:()]+$/g, "");

  if (b) return `What is "${b}"?`;
  if (a) return `What value goes before "${a}"?`;
  return "What value goes here?";
}

async function extractBlankFields(buffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  const fields = [];
  let counter = 0;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const [, , , pageHeight] = page.view;
    const MARGIN = 54; // skip header/footer zones (page numbers, running headers)

    // Group text items into "tokens" — splitting any item that contains a
    // run of underscores into (text, blank, text, ...) pieces, each with an
    // approximate x position based on character offset.
    const tokens = [];
    for (const item of content.items) {
      const str = item.str;
      if (!str) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      if (y < MARGIN || y > pageHeight - MARGIN) continue;
      if (x < 30 && /^\d{1,3}$/.test(str.trim())) continue; // left-margin line numbers
      if (str.trim() === "q") continue; // Wingdings checkbox glyph rendered as "q"
      const width = item.width || 0;
      const len = str.length || 1;

      let lastIndex = 0;
      let match;
      BLANK_RE.lastIndex = 0;
      let hadBlank = false;
      while ((match = BLANK_RE.exec(str)) !== null) {
        hadBlank = true;
        if (match.index > lastIndex) {
          const piece = str.slice(lastIndex, match.index);
          tokens.push({ type: "text", text: piece, x: x + (width * lastIndex) / len, y });
        }
        tokens.push({ type: "blank", x: x + (width * match.index) / len, y, page: pageNum });
        lastIndex = BLANK_RE.lastIndex;
      }
      if (!hadBlank) {
        tokens.push({ type: "text", text: str, x, y });
      } else if (lastIndex < str.length) {
        tokens.push({ type: "text", text: str.slice(lastIndex), x: x + (width * lastIndex) / len, y });
      }
    }

    // Group tokens into lines using a y-tolerance (text on the "same line"
    // can have slightly different y values due to mixed fonts/sizes).
    const sorted = [...tokens].sort((a, b) => b.y - a.y || a.x - b.x);
    const Y_TOLERANCE = 2.5;
    const lineGroups = [];
    for (const tok of sorted) {
      let group = lineGroups.find((g) => Math.abs(g.y - tok.y) <= Y_TOLERANCE);
      if (!group) {
        group = { y: tok.y, items: [] };
        lineGroups.push(group);
      }
      group.items.push(tok);
    }
    lineGroups.sort((a, b) => b.y - a.y);

    for (const group of lineGroups) {
      const lineTokens = group.items.sort((a, b) => a.x - b.x);
      const lineText = lineTokens.map((t) => (t.type === "text" ? t.text : "____")).join("");

      const blankIdxs = lineTokens.map((t, i) => (t.type === "blank" ? i : -1)).filter((i) => i >= 0);

      lineTokens.forEach((tok, idx) => {
        if (tok.type !== "blank") return;
        const priorBlanks = blankIdxs.filter((i) => i < idx);
        const prevBlank = priorBlanks.length ? Math.max(...priorBlanks) : -1;
        const laterBlanks = blankIdxs.filter((i) => i > idx);
        const nextBlank = laterBlanks.length ? Math.min(...laterBlanks) : lineTokens.length;
        const before = lineTokens
          .slice(prevBlank + 1, idx)
          .map((t) => (t.type === "text" ? t.text : "____"))
          .join("");
        const after = lineTokens
          .slice(idx + 1, nextBlank)
          .map((t) => (t.type === "text" ? t.text : "____"))
          .join("");

        fields.push({
          id: `f${counter++}`,
          type: "blank",
          page: pageNum - 1,
          x: tok.x,
          y: tok.y,
          context: cleanLabel(lineText),
          question: buildQuestion(before, after),
          label: cleanLabel(before).slice(-40) || cleanLabel(after).slice(0, 40),
        });
      });
    }
  }

  // A line that is *only* a blank (e.g. a wrapped continuation of the
  // previous line's blank, often used for multi-line addresses) carries no
  // useful context of its own. Link it to the previous "real" field so the
  // chatbot doesn't ask a separate, contentless question, but still fill
  // both spots with the same answer.
  let lastReal = null;
  for (const f of fields) {
    // Treat as "no useful context" if the line has fewer than 3 letters
    // once blanks/punctuation are stripped (e.g. "____ ...." or "on ____ .").
    const isBlankOnly = f.context.replace(/[^A-Za-z]/g, "").length < 3;
    if (isBlankOnly && lastReal) {
      f.linkedTo = lastReal.id;
      f.context = lastReal.context;
      f.question = lastReal.question;
      f.label = lastReal.label;
    } else if (!isBlankOnly) {
      lastReal = f;
    }
  }

  return fields;
}

function describeAcroField(field) {
  const name = field.getName();
  const label = name.replace(/[._]/g, " ").trim();
  const ctor = field.constructor.name;

  let type = "text";
  let options = null;
  if (ctor === "PDFCheckBox") type = "checkbox";
  else if (ctor === "PDFRadioGroup") {
    type = "radio";
    options = field.getOptions();
  } else if (ctor === "PDFDropdown") {
    type = "dropdown";
    options = field.getOptions();
  } else if (ctor === "PDFOptionList") {
    type = "dropdown";
    options = field.getOptions();
  }

  let question;
  if (type === "checkbox") {
    question = `Does "${label}" apply? (yes/no)`;
  } else if (type === "radio" || type === "dropdown") {
    question = `${label}? Choose one of: ${(options || []).join(", ")}`;
  } else {
    question = `Please provide a value for "${label}":`;
  }

  return { name, label, type, options, question };
}

async function extractAcroFields(pdfDoc) {
  const form = pdfDoc.getForm();
  const acroFields = form.getFields().filter((f) => f.constructor.name !== "PDFSignature");
  return acroFields.map((field, idx) => {
    const desc = describeAcroField(field);
    return {
      id: `f${idx}`,
      type: desc.type,
      name: desc.name,
      label: desc.label,
      context: desc.label,
      question: desc.question,
      options: desc.options,
    };
  });
}

// Top-level entry point: load the PDF, decide whether it has AcroForm
// fields, and return { mode, fields }.
async function analyzePdf(buffer) {
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const acroFields = form.getFields().filter((f) => f.constructor.name !== "PDFSignature");

  if (acroFields.length > 0) {
    const fields = await extractAcroFields(pdfDoc);
    return { mode: "acroform", fields };
  }

  const fields = await extractBlankFields(buffer);
  return { mode: "blanks", fields };
}

module.exports = { analyzePdf };
