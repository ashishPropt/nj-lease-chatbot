// Analyzes an uploaded PDF and produces a flat list of "fields" to ask the
// user about, plus enough info to fill the answers back into the PDF.
//
// Two modes:
//  - "acroform": the PDF has real AcroForm fields (text/checkbox/radio/dropdown).
//  - "blanks": the PDF is a flattened form with literal underscore blanks ("______").

const { PDFDocument } = require("pdf-lib");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const BLANK_RE = /_{3,}/g;

// A section heading is a SHORT all-caps or numbered line with no blanks
// and no lowercase (so long legal sentences are excluded).
// e.g. "3. TERM", "2. PROPERTY", "PARTIES"
const HEADING_RE = /^(\d+\.)?\s*[A-Z][A-Z\s'\/\-]{1,}[A-Z]\.?$/;

// Detects "4. RENT" or "27. RENEWAL OF LEASE" embedded at start of a clause line.
const INLINE_HEADING_RE = /^(\d+\.\s+[A-Z][A-Z\s'\/\-]{1,}[A-Z])[\s:.]/;

function cleanLabel(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Build a SHORT, non-redundant question. The full clause line (context) is
// already shown above, so the question just names the field concisely.
function buildQuestion(before, after) {
  // Strip ALL trailing punctuation/parens/brackets from the "before" text
  // so we get a clean label like "BETWEEN LANDLORD" or "rent for the Term is $"
  const b = cleanLabel(before).replace(/[\s,.;:()\[\]{}#]+$/g, "");
  // Strip ALL leading punctuation from "after"
  const a = cleanLabel(after).replace(/^[\s,.;:()\[\]{}#]+/, "");

  if (b) {
    // Use the last clause after a colon or period-space to skip long preamble.
    // Then strip any stray parens/brackets from the final label.
    const segments = b.split(/:\s+|\.\s+/);
    const raw = segments[segments.length - 1].trim().slice(-60);
    const label = raw.replace(/[()[\]{}]+/g, "").replace(/\s+/g, " ").trim();
    if (label) return `Enter ${label}:`;
  }
  if (a) {
    // First meaningful word-group from the "after" text
    const raw = a.split(/[,.;:()\[\]{}]/)[0].trim().slice(0, 40);
    const label = raw.replace(/[()[\]{}]+/g, "").trim();
    if (label) return `Enter value (goes before "${label}"):`;
  }
  return "Enter the value for this blank:";
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
  let currentHeading = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const [, , , pageHeight] = page.view;
    const MARGIN = 54; // skip header/footer zones

    // Build tokens, splitting items that contain underscore-runs into pieces
    const tokens = [];
    for (const item of content.items) {
      const str = item.str;
      if (!str) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      if (y < MARGIN || y > pageHeight - MARGIN) continue;
      if (x < 30 && /^\d{1,3}$/.test(str.trim())) continue; // left-margin line numbers
      if (str.trim() === "q") continue; // Wingdings unchecked-checkbox glyph

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

    // Cluster tokens into visual lines using a y-tolerance
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
      const hasBlank = lineTokens.some((t) => t.type === "blank");

      // Detect section headings (no blanks, short, all-caps or numbered)
      if (!hasBlank) {
        const cleaned = cleanLabel(lineText);
        if (HEADING_RE.test(cleaned) && cleaned.length < 50) {
          currentHeading = cleaned;
        }
        continue;
      }

      // Also pick up "4. RENT: ..." style headings embedded in a clause line
      const inlineMatch = cleanLabel(lineText).match(INLINE_HEADING_RE);
      if (inlineMatch) currentHeading = inlineMatch[1].trim();

      const blankIdxs = lineTokens.map((t, i) => (t.type === "blank" ? i : -1)).filter((i) => i >= 0);

      lineTokens.forEach((tok, idx) => {
        if (tok.type !== "blank") return;

        const priorBlanks = blankIdxs.filter((i) => i < idx);
        const laterBlanks = blankIdxs.filter((i) => i > idx);
        const prevBlank = priorBlanks.length ? Math.max(...priorBlanks) : -1;
        const nextBlank = laterBlanks.length ? Math.min(...laterBlanks) : lineTokens.length;

        const before = lineTokens.slice(prevBlank + 1, idx).map((t) => (t.type === "text" ? t.text : "")).join("");
        const after = lineTokens.slice(idx + 1, nextBlank).map((t) => (t.type === "text" ? t.text : "")).join("");

        fields.push({
          id: `f${counter++}`,
          type: "blank",
          page: pageNum - 1,
          x: tok.x,
          y: tok.y,
          heading: currentHeading,
          context: cleanLabel(lineText),
          question: buildQuestion(before, after),
          label: cleanLabel(before).slice(-40) || cleanLabel(after).slice(0, 40),
        });
      });
    }
  }

  // Link blank-only continuation lines (< 3 letters in context) to the
  // previous real field — same answer fills both positions.
  let lastReal = null;
  for (const f of fields) {
    const isBlankOnly = f.context.replace(/[^A-Za-z]/g, "").length < 3;
    if (isBlankOnly && lastReal) {
      f.linkedTo = lastReal.id;
      f.heading = lastReal.heading;
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
    question = `Enter ${label}:`;
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
      heading: "",
      context: desc.label,
      question: desc.question,
      options: desc.options,
    };
  });
}

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
