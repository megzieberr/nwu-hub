// reminders.mjs — the PURE scheduling logic for the send-push reminder sender.
//
// Extracted from index.ts so it can be unit-tested on Node (see sync/verify-reminders.mjs) without a
// live Deno/Supabase/web-push stack. Plain JS, zero dependencies, no I/O — Deno imports it as a
// sibling of index.ts, Node imports it from the test. Every function is a deterministic predicate of
// (row/goal, now); "now" is the { date, minutes } object saNow() produces, so tests inject a fixed one.
//
// All times are South African (UTC+2, no DST). Keep this file's decisions in lockstep with the loop
// in index.ts — the whole point is that the test exercises the SAME code the function runs.

export const MORNING_MIN = 7 * 60;   // 07:00 SAST — morning-of ping for tests/exams (and time-less classes)
export const CLASS_LEAD = 45;        // minutes before a class to remind

// "Now" in South African time: today's date and minutes-since-midnight. Inject `d` in tests.
export function saNow(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const hh = p.hour === "24" ? "00" : p.hour;           // Intl can emit "24" at midnight
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: parseInt(hh, 10) * 60 + parseInt(p.minute, 10),
  };
}

// The SAST calendar date of a timestamptz (for the "already reminded today?" check).
export function saDateOf(ts) {
  if (!ts) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts));
}

// Weekday of a YYYY-MM-DD, timezone-stable (0=Sun … 6=Sat). Used to place recurring classes.
export function dow(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

// "HH:MM:SS" / "HH:MM" → minutes since midnight, or null.
export function timeMin(t) {
  if (typeof t !== "string") return null;
  const m = t.match(/^(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// "HH:MM:SS" → "HH:MM" for display.
export function hhmm(t) {
  return typeof t === "string" ? t.slice(0, 5) : "";
}

// Already reminded today? (per-day dedupe, so recurring classes re-arm each week).
export function remindedToday(remindedAt, now) {
  return saDateOf(remindedAt) === now.date;
}

// Is this exam row about TODAY's sitting? A dated row must be dated today; an undated row must have
// been CREATED today (SALA posts the code the exam morning) — excludes historical undated rows and
// manually-entered future exams.
export function examRelevantToday(row, now) {
  return row.event_date === now.date
    || (row.event_date == null && saDateOf(row.created_at) === now.date);
}

// Should the exam reminder fire now? While the register window is still open (now < code_close); with
// no known window, from 07:00 on.
export function examDue(row, now) {
  const closeMin = timeMin(row.code_close);
  return closeMin !== null ? now.minutes < closeMin : now.minutes >= MORNING_MIN;
}

// Is today this class's day? Recurring → same weekday AND the series has already started (target_date
// is its first occurrence, so never remind for weeks BEFORE it begins). One-off → the exact date.
export function classOnToday(goal, now) {
  if (!goal.target_date) return false;
  if (!goal.recurring) return goal.target_date === now.date;
  return dow(goal.target_date) === dow(now.date) && now.date >= goal.target_date;
}

// Should the class reminder fire now? No time → a 07:00 nudge; with a time → the first tick within
// CLASS_LEAD minutes before it (never after start).
export function classDue(goal, now) {
  const tmin = timeMin(goal.target_time);
  if (tmin === null) return now.minutes >= MORNING_MIN;
  const until = tmin - now.minutes;
  return until > 0 && until <= CLASS_LEAD;
}
