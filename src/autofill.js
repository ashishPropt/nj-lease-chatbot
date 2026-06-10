// Helpers to derive answers automatically from previously-given answers.

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Parse a loosely-formatted date string into a Date (UTC midnight) or null.
 * Accepts forms like "1/1/2026", "01-01-2026", "January 1, 2026", "Jan 1 2026".
 */
function parseDate(str) {
  if (!str) return null;
  const s = str.trim();

  // M/D/YYYY or M-D-YYYY
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const [, mo, d, y] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d));
  }

  // Month D, YYYY  or  Month D YYYY
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) {
    const [, monName, d, y] = m;
    const idx = MONTHS.indexOf(monName.toLowerCase());
    if (idx >= 0) return new Date(Date.UTC(+y, idx, +d));
  }

  // Fallback to native parser
  const native = new Date(s);
  if (!isNaN(native.getTime())) {
    return new Date(Date.UTC(native.getFullYear(), native.getMonth(), native.getDate()));
  }

  return null;
}

/**
 * Parse a lease-term length string like "12 months", "1 year", "6 mo" into
 * { months } or null.
 */
function parseTermLength(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(month|mo|year|yr)/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2];
  const months = unit.startsWith("y") ? value * 12 : value;
  return { months };
}

function formatDate(date) {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Given the start date string and term length string, compute the lease
 * end date string (start + term, minus one day). Returns null if either
 * input can't be parsed.
 */
function computeTermEnd(termStartStr, termLengthStr) {
  const start = parseDate(termStartStr);
  const term = parseTermLength(termLengthStr);
  if (!start || !term) return null;

  const end = new Date(start.getTime());
  const wholeMonths = Math.trunc(term.months);
  const fractionMonths = term.months - wholeMonths;

  end.setUTCMonth(end.getUTCMonth() + wholeMonths);
  if (fractionMonths) {
    end.setUTCDate(end.getUTCDate() + Math.round(fractionMonths * 30));
  }
  // End date is the day before the anniversary of the start date.
  end.setUTCDate(end.getUTCDate() - 1);

  return formatDate(end);
}

/**
 * Registry of autofill rules. Each rule may compute a suggested value for
 * a given field based on the answers collected so far.
 */
const RULES = {
  term_end: (answers) => computeTermEnd(answers.term_start, answers.term_length),
};

/**
 * Returns a suggested value for the given field id, or null if no
 * suggestion is available.
 */
function getSuggestion(fieldId, answers) {
  const rule = RULES[fieldId];
  if (!rule) return null;
  try {
    return rule(answers) || null;
  } catch {
    return null;
  }
}

module.exports = { getSuggestion, computeTermEnd, parseDate, parseTermLength };
