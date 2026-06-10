// Generic "smart fill" rules: derive a suggested answer for a field from
// answers already given for other fields (e.g. lease end date from start
// date + term length).

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function parseDate(str) {
  if (!str) return null;
  const s = str.trim();

  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, mo, d, y] = m;
    if (y.length === 2) y = `20${y}`;
    return new Date(Date.UTC(+y, +mo - 1, +d));
  }

  m = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) {
    const [, monName, d, y] = m;
    const idx = MONTHS.indexOf(monName.toLowerCase());
    if (idx >= 0) return new Date(Date.UTC(+y, idx, +d));
  }

  const native = new Date(s);
  if (!isNaN(native.getTime())) {
    return new Date(Date.UTC(native.getFullYear(), native.getMonth(), native.getDate()));
  }

  return null;
}

function parseTermLength(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(month|mo|year|yr|week|wk|day)/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2];
  let months;
  if (unit.startsWith("y")) months = value * 12;
  else if (unit.startsWith("mo")) months = value;
  else return { days: unit.startsWith("w") ? value * 7 : value };
  return { months };
}

function formatDate(date) {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function computeTermEnd(termStartStr, termLengthStr) {
  const start = parseDate(termStartStr);
  const term = parseTermLength(termLengthStr);
  if (!start || !term) return null;

  const end = new Date(start.getTime());
  if (term.months != null) {
    const wholeMonths = Math.trunc(term.months);
    const fractionMonths = term.months - wholeMonths;
    end.setUTCMonth(end.getUTCMonth() + wholeMonths);
    if (fractionMonths) end.setUTCDate(end.getUTCDate() + Math.round(fractionMonths * 30));
  } else if (term.days != null) {
    end.setUTCDate(end.getUTCDate() + term.days);
  }
  end.setUTCDate(end.getUTCDate() - 1);

  return formatDate(end);
}

const END_DATE_RE = /\b(end(ing)?|expir|termination)\b.*\b(date|on)\b|\bend(ing)?\s*date\b/i;
const START_DATE_RE = /\b(start(ing)?|begin(ning)?|commenc\w*|effective)\b.*\b(date|on)\b/i;
const TERM_LENGTH_RE = /\b(term|length|duration)\b/i;

function fieldText(field) {
  return `${field.label || ""} ${field.context || ""} ${field.question || ""}`;
}

// Returns a suggested value for `field`, or null if none applies.
// `fields` is the full ordered list of fields for this form; `answers` is
// the map of fieldId -> answer collected so far.
function getSuggestion(field, fields, answers) {
  if (field.type && field.type !== "text" && field.type !== "blank") return null;

  const text = fieldText(field);
  if (!END_DATE_RE.test(text)) return null;

  let startAnswer = null;
  let termAnswer = null;
  for (const f of fields) {
    const ans = answers[f.id];
    if (!ans) continue;
    const ft = fieldText(f);
    if (!startAnswer && START_DATE_RE.test(ft) && parseDate(ans)) startAnswer = ans;
    if (!termAnswer && TERM_LENGTH_RE.test(ft) && parseTermLength(ans)) termAnswer = ans;
  }

  if (!startAnswer || !termAnswer) return null;
  return computeTermEnd(startAnswer, termAnswer);
}

module.exports = { getSuggestion, computeTermEnd, parseDate, parseTermLength };
