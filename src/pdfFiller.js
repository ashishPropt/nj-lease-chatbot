const PDFDocument = require("pdfkit");

/**
 * Generates a filled-lease summary PDF as a Buffer from a set of question/answer pairs.
 */
function generateLeasePdf(questions, answers) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).font("Helvetica-Bold").text("NJ REALTORS Form 125 - Residential Lease", { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(12).font("Helvetica").text("Completed Answers Summary", { align: "center" });
    doc.moveDown(1);

    questions.forEach((q) => {
      doc.fontSize(11).font("Helvetica-Bold").text(`${q.section} - ${q.question}`);
      doc.moveDown(0.2);
      const ans = (answers[q.id] || "").toString().trim() || "(not provided)";
      doc.fontSize(11).font("Helvetica").text(ans);
      doc.moveDown(0.8);
    });

    doc.end();
  });
}

module.exports = { generateLeasePdf };
