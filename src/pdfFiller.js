const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

async function fillAcroForm(buffer, fields, answers) {
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const form = pdfDoc.getForm();

  for (const f of fields) {
    const value = (answers[f.id] || "").toString().trim();
    if (!value) continue;
    try {
      if (f.type === "checkbox") {
        const cb = form.getCheckBox(f.name);
        if (/^(y|yes|true|x|on|check)/i.test(value)) cb.check();
        else cb.uncheck();
      } else if (f.type === "radio") {
        const rg = form.getRadioGroup(f.name);
        const opt = (f.options || []).find((o) => o.toLowerCase() === value.toLowerCase()) || value;
        rg.select(opt);
      } else if (f.type === "dropdown") {
        const dd = form.getDropdown(f.name);
        const opt = (f.options || []).find((o) => o.toLowerCase() === value.toLowerCase()) || value;
        dd.select(opt);
      } else {
        const tf = form.getTextField(f.name);
        tf.setText(value);
      }
    } catch {
      // If a field can't be set as expected, skip it rather than failing the whole document.
    }
  }

  try {
    form.flatten();
  } catch {
    // Some forms fail to flatten cleanly; leave fields editable in that case.
  }

  return Buffer.from(await pdfDoc.save());
}

async function fillBlanks(buffer, fields, answers) {
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  for (const f of fields) {
    const value = (answers[f.id] || "").toString().trim();
    if (!value) continue;
    const page = pages[f.page];
    if (!page) continue;

    const fontSize = 9;
    page.drawText(value, {
      x: f.x,
      y: f.y + 1,
      size: fontSize,
      font,
      color: rgb(0, 0, 0.55),
    });
  }

  return Buffer.from(await pdfDoc.save());
}

async function fillPdf(buffer, mode, fields, answers) {
  if (mode === "acroform") return fillAcroForm(buffer, fields, answers);
  return fillBlanks(buffer, fields, answers);
}

module.exports = { fillPdf };
