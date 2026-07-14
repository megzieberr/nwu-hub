// exam-parse.js — deterministic extraction of a SALA "Exam opportunity" announcement into an
// exam_access row (Feature A). Dependency-free so it's unit-testable without the Anthropic SDK.
//
// At exam time the ONE thing Megan must not lose is the access code she types into the Invigilator
// agent inside a short register window. This regex pass pulls the code + window + write time +
// eFundi link out of the fixed SALA template so the Tests & Exams tab can surface them big — no LLM
// cost, no digging. Gated on the access code (the hero field) so ordinary announcements never make
// a row. Returns a partial exam_access row, or null when it isn't an exam-access notice.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "08:30" / "08h30" / "08.30" -> "08:30:00" (a Postgres time), else null.
function normTime(s) {
  const m = /^\s*(\d{1,2})[:h.](\d{2})\s*$/.exec(s || '');
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

// Find a write date. Accepts YYYY-MM-DD or "15 July[ 2026]" / "15 Jul". Resolves a missing year
// forward from `today` (never a past year). Returns 'YYYY-MM-DD' or null.
function findDate(body, today) {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(body);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/i.exec(body);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mon || day < 1 || day > 31) return null;
  const thisYear = Number(today.slice(0, 4));
  let year = m[3] ? Number(m[3]) : thisYear;
  const pad = (n) => String(n).padStart(2, '0');
  const cand = `${year}-${pad(mon)}-${pad(day)}`;
  if (!m[3] && cand < today) year += 1;   // no stated year and already passed -> next year
  return `${year}-${pad(mon)}-${pad(day)}`;
}

export function parseExamAccess(title, body, today) {
  const code = /Exam\s+QR\s+Access\s+Code\s*:?\s*([0-9a-z]{5,16})\b/i.exec(body);
  if (!code) return null;   // the code is the trigger — no code, not an exam-access announcement.

  // Register window: "open at 08:30 and close at 08:59" (tolerant of wording/order between them).
  const win = /open[a-z]*\s+at\s+(\d{1,2}[:h.]\d{2})[\s\S]{0,60}?clos[a-z]*\s+at\s+(\d{1,2}[:h.]\d{2})/i.exec(body);
  // Assessment start: the SALA template phrases this as "available at 09:00" — anchor to that so we
  // don't grab the register window's "open at 08:30". Fall back to an "assessment … at HH:MM" phrase.
  const start = /\bavailable\s+(?:from\s+|at\s+)?(\d{1,2}[:h.]\d{2})/i.exec(body)
    || /\bassessment\b[\s\S]{0,40}?\bat\s+(\d{1,2}[:h.]\d{2})/i.exec(body);
  const url = (/(https?:\/\/efundi\.nwu\.ac\.za\/\S+)/i.exec(body) || /(https?:\/\/\S+)/i.exec(body) || [])[1] || null;

  const cleanTitle = String(title || '')
    .replace(/\s*[-–—]?\s*\(?\s*QR\s*code\s*attached\s*\)?\.?\s*$/i, '')
    .replace(/\s*[-–—]\s*$/, '').trim() || 'Exam';
  const kind = /\btest\b/i.test(title + ' ' + body) && !/\bexam\b/i.test(title) ? 'test' : 'exam';

  return {
    kind,
    title: cleanTitle.slice(0, 200),
    access_code: code[1],
    code_open: win ? normTime(win[1]) : null,
    code_close: win ? normTime(win[2]) : null,
    start_time: start ? normTime(start[1]) : null,
    event_date: findDate(body, today),
    efundi_url: url && url.replace(/[).,]+$/, ''),
  };
}

// SAST (UTC+2, no DST) calendar date 'YYYY-MM-DD' of a timestamp, or null on empty/bad input.
export function saDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// The exam's calendar date for the reminder. The REAL SALA body carries no date (parseExamAccess then
// yields event_date=null), so fall back to the SAST date the announcement was POSTED — SALA releases
// the code the exam morning, so posted-date == exam-date. (Residual: an evening-before post dates one
// day early; send-push's created-today clause is the net for that.) Returns 'YYYY-MM-DD' or null.
export function resolveEventDate(parsedDate, postedAt) {
  return parsedDate || saDate(postedAt) || null;
}
