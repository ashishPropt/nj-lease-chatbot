// Parse a filled PDF to extract what was filled in and what the original
// question/blank context was.
//
// Three strategies, tried in order:
//   1. AcroForm fields — read field names and current values directly.
//   2. Color-detect — find text drawn in our specific fill color (blue tint)
//      vs the original black form text.
//   3. Diff against original — compare text content of original + filled PDF;
//      text that appears in filled but not original is the filled-in answer.

const { PDFDocument } = require("pdf-lib");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { analyzePdf } = require("./pdfForm");

// The color we use when overlaying answers (rgb(0, 0, 0.55) in pdf-lib → blue)
const FILL_COLOR_B_MIN = 0.4; // blue channel threshold

// ── Strategy 1: AcroForm ─────────────────────────────────────────────────────

async function parseAcroForm(buffer) {
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields().filter((f) => f.constructor.name !== "PDFSignature");
  if (fields.length === 0) return null;

  return fields.map((field) => {
    const name = field.getName();
    const label = name.replace(/[._]/g, " ").trim();
    const ctor = field.constructor.name;
    let value = "";
    try {
      if (ctor === "PDFTextField") value = field.getText() || "";
      else if (ctor === "PDFCheckBox") value = field.isChecked() ? "Yes" : "No";
      else if (ctor === "PDFRadioGroup") value = field.getSelected() || "";
      else if (ctor === "PDFDropdown") value = (field.getSelected() || []).join(", ");
    } catch { value = "(unreadable)"; }
    return { question: `Enter ${label}:`, context: label, answer: value };
  });
}

// ── Strategy 2: Color-detect (our overlay fills are blue-tinted) ──────────────

async function parseByColor(buffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const results = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const ops = await page.getOperatorList();
    const content = await page.getTextContent();

    // Build a set of (approx) positions where a blue fill color was active.
    // pdf.js operator list lets us track color changes interleaved with text.
    // OPS: setFillRGBColor=80, setFillGray=83, setFillColorSpace=84,
    //      showText=49, showSpacedText=50, nextLineShowText=51, etc.
    const BLUE_OPS = new Set([80]); // Tf setFillRGBColor
    let blueActive = false;
    const blueRanges = new Set();
    let textIdx = 0;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === 80) { // setFillRGBColor
        const [r, g, b] = ops.argsArray[i];
        blueActive = (b >= FILL_COLOR_B_MIN && r < 0.1 && g < 0.1);
      } else if (fn === 83) { // setFillGray
        blueActive = false;
      } else if ([49, 50, 51, 52].includes(fn)) {
        if (blueActive) blueRanges.add(textIdx);
        textIdx++;
      }
    }

    // Collect items that were rendered in blue (our fill color)
    let itemCount = 0;
    const filled = [];
    for (const item of content.items) {
      if (blueRanges.has(itemCount) && item.str && item.str.trim()) {
        filled.push({ str: item.str.trim(), x: item.transform[4], y: item.transform[5] });
      }
      itemCount++;
    }
    results.push(...filled.map((f) => ({ page: pageNum, ...f })));
  }

  return results.length > 0 ? results : null;
}

// ── Strategy 3: Diff original vs filled ──────────────────────────────────────

async function extractPageTexts(buffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => ({ str: i.str, x: Math.round(i.transform[4]), y: Math.round(i.transform[5]) })));
  }
  return pages;
}

function diffPages(originalPages, filledPages) {
  const added = [];
  for (let p = 0; p < Math.min(originalPages.length, filledPages.length); p++) {
    const origSet = new Set(originalPages[p].map((i) => `${i.str}|${i.x}|${i.y}`));
    for (const item of filledPages[p]) {
      const key = `${item.str}|${item.x}|${item.y}`;
      if (!origSet.has(key) && item.str.trim() && !/^_+$/.test(item.str)) {
        added.push({ page: p + 1, str: item.str.trim(), x: item.x, y: item.y });
      }
    }
  }
  return added;
}

// ── Match filled values back to original questions ────────────────────────────

function matchAnswersToFields(filledItems, fields) {
  const questionFields = fields.filter((f) => !f.linkedTo);
  return questionFields.map((f) => {
    // Find the filled item closest to this blank's position
    const candidates = filledItems.filter((item) => item.page === f.page + 1);
    let best = null, bestDist = Infinity;
    for (const item of candidates) {
      const dist = Math.abs(item.x - f.x) + Math.abs(item.y - f.y);
      if (dist < bestDist) { bestDist = dist; best = item; }
    }
    return {
      heading: f.heading || "",
      context: f.context,
      question: f.question,
      answer: best && bestDist < 80 ? best.str : "",
    };
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function parseFilledPdf(filledBuffer, originalBuffer) {
  // Strategy 1: AcroForm
  const acro = await parseAcroForm(filledBuffer);
  if (acro) return { mode: "acroform", fields: acro };

  // Strategy 2: color-detect (works for PDFs we filled ourselves)
  const colored = await parseByColor(filledBuffer);

  // We always need the original to know the questions; if not provided,
  // return what we found without question context.
  if (!originalBuffer) {
    if (colored) {
      return {
        mode: "color-detect",
        fields: colored.map((c) => ({
          heading: "",
          context: "",
          question: "",
          answer: c.str,
          page: c.page,
        })),
      };
    }
    return { mode: "none", fields: [], error: "Could not detect filled values. Please also upload the original blank form for comparison." };
  }

  // Analyze original to get field positions + questions
  const { fields } = await analyzePdf(originalBuffer);

  if (colored) {
    return { mode: "color-detect", fields: matchAnswersToFields(colored, fields) };
  }

  // Strategy 3: text diff
  const [origPages, filledPages] = await Promise.all([
    extractPageTexts(originalBuffer),
    extractPageTexts(filledBuffer),
  ]);
  const diffItems = diffPages(origPages, filledPages);
  return { mode: "diff", fields: matchAnswersToFields(diffItems, fields) };
}

module.exports = { parseFilledPdf };
