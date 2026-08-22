// ics.mjs — the PURE calendar builder for the ics-feed Edge Function.
//
// Extracted from index.ts so it can be unit-tested on Node (see sync/verify-ics.mjs) without a live
// Deno/Supabase stack — same split as supabase/functions/send-push/reminders.mjs. Plain JS, zero
// dependencies, no I/O. Deno imports it as a sibling of index.ts; Node imports it from the test.
//
// `classes` rows shape (from `goals` joined to `modules` for the code):
//   { id, text, target_date ('YYYY-MM-DD'), target_time ('HH:MM:SS'|null), recurring, link, code,
//     created_at }
//
// All wall-clock arithmetic (the +1h DTEND, the all-day DTEND, DTSTAMP) is done on the naive
// date/time values with a `Z`-suffix trick purely to reuse Date's UTC getters/setters — Africa/
// Johannesburg has no DST, so there is no real timezone conversion to do; the actual UTC offset is
// carried by the VTIMEZONE block and the `TZID=` parameter, not by this arithmetic.

const HUB_URL = "https://megzieberr.github.io/nwu-hub/";
const OLD_CUTOFF_DAYS = 60;

// ---------- RFC 5545 text escaping (backslash, comma, semicolon, embedded newline) -------------
export function escapeText(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// ---------- RFC 5545 line folding: CRLF + single-space continuation, 75 octets/physical line ---
// First physical line carries up to 75 octets of content; each continuation line carries a
// leading space (1 octet) + up to 74 octets of content = 75 octets total. Never splits a
// multi-byte UTF-8 sequence apart (backs off to the last full-character boundary).
export function foldLine(line) {
  const bytes = new TextEncoder().encode(String(line));
  if (bytes.length <= 75) return line + "\r\n";

  const decoder = new TextDecoder();
  let out = "";
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const limit = first ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // Back off while `end` lands inside a UTF-8 continuation byte (10xxxxxx).
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + limit, bytes.length); // pathological fallback
    out += (first ? "" : " ") + decoder.decode(bytes.slice(start, end)) + "\r\n";
    start = end;
    first = false;
  }
  return out;
}

function line(name, value) {
  return foldLine(`${name}:${value}`);
}

// ---------- SUMMARY text: "CODE · <rest>", stripping the leading "CODE:"/"CODE " prefix and the
// trailing " — <date/time tail>" that the objectives agent bakes into `text`. -------------------
function escapeRegExp(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function summaryFor(row) {
  const code = row.code || "";
  let rest = row.text || "";
  if (code) {
    rest = rest.replace(new RegExp(`^${escapeRegExp(code)}[:]?\\s*`), "");
  }
  rest = rest.replace(/\s*—.*$/, "").trim();
  return `${code} · ${rest || "class"}`;
}

// ---------- date/time helpers (naive wall-clock math, see header note) -------------------------
function pad2(n) {
  return String(n).padStart(2, "0");
}

function normTime(t) {
  // "HH:MM" or "HH:MM:SS" -> "HH:MM:SS"
  const m = String(t).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "00:00:00";
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}

function compactDate(dateStr) {
  return dateStr.replace(/-/g, "");
}

function compactTime(timeStr) {
  return normTime(timeStr).replace(/:/g, "");
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function daysBefore(dateLike, days) {
  const d = new Date(dateLike);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Add minutes to a (date, time) pair, rolling over midnight into the next day as needed.
function addMinutes(dateStr, timeStr, minutes) {
  const d = new Date(`${dateStr}T${normTime(timeStr)}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 19) };
}

function toUtcStamp(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

// ---------- one VEVENT ---------------------------------------------------------------------------
function buildEvent(row) {
  const out = [];
  out.push(line("BEGIN", "VEVENT"));
  out.push(line("UID", `${row.id}@nwu-hub`));
  out.push(line("DTSTAMP", toUtcStamp(row.created_at)));
  const summary = summaryFor(row);
  out.push(line("SUMMARY", escapeText(summary)));

  let timed = false;
  if (row.target_time) {
    timed = true;
    const startDate = compactDate(row.target_date);
    const startTime = compactTime(row.target_time);
    out.push(line("DTSTART;TZID=Africa/Johannesburg", `${startDate}T${startTime}`));
    const end = addMinutes(row.target_date, row.target_time, 60);
    out.push(line("DTEND;TZID=Africa/Johannesburg", `${compactDate(end.date)}T${compactTime(end.time)}`));
  } else {
    out.push(line("DTSTART;VALUE=DATE", compactDate(row.target_date)));
    out.push(line("DTEND;VALUE=DATE", compactDate(nextDay(row.target_date))));
  }

  if (row.recurring) out.push(line("RRULE", "FREQ=WEEKLY"));

  const descParts = [];
  if (row.link) descParts.push(`Join: ${row.link}`);
  descParts.push(`Hub: ${HUB_URL}`);
  out.push(line("DESCRIPTION", escapeText(descParts.join("\n"))));

  if (row.link) out.push(line("URL", row.link));
  out.push(line("LOCATION", "Online (Teams)"));

  if (timed) {
    out.push(line("BEGIN", "VALARM"));
    out.push(line("ACTION", "DISPLAY"));
    out.push(line("TRIGGER", "-PT30M"));
    out.push(line("DESCRIPTION", escapeText(summary)));
    out.push(line("END", "VALARM"));
  }

  out.push(line("END", "VEVENT"));
  return out.join("");
}

// ---------- the whole calendar --------------------------------------------------------------
export function buildCalendar(classes, { now = new Date() } = {}) {
  const cutoff = daysBefore(now, OLD_CUTOFF_DAYS);

  const rows = (classes || [])
    .filter((r) => !!r.target_date)
    .filter((r) => r.recurring || r.target_date >= cutoff)
    .slice()
    .sort((a, b) => {
      if (a.target_date !== b.target_date) return a.target_date < b.target_date ? -1 : 1;
      const at = a.target_time || "";
      const bt = b.target_time || "";
      if (at !== bt) return at < bt ? -1 : 1;
      return 0;
    });

  const out = [];
  out.push(line("BEGIN", "VCALENDAR"));
  out.push(line("PRODID", "-//NWU Study Hub//ics-feed//EN"));
  out.push(line("VERSION", "2.0"));
  out.push(line("CALSCALE", "GREGORIAN"));
  out.push(line("METHOD", "PUBLISH"));
  out.push(line("X-WR-CALNAME", "NWU classes"));
  out.push(line("X-WR-TIMEZONE", "Africa/Johannesburg"));

  out.push(line("BEGIN", "VTIMEZONE"));
  out.push(line("TZID", "Africa/Johannesburg"));
  out.push(line("BEGIN", "STANDARD"));
  out.push(line("DTSTART", "19700101T000000"));
  out.push(line("TZOFFSETFROM", "+0200"));
  out.push(line("TZOFFSETTO", "+0200"));
  out.push(line("TZNAME", "SAST"));
  out.push(line("END", "STANDARD"));
  out.push(line("END", "VTIMEZONE"));

  for (const row of rows) out.push(buildEvent(row));

  out.push(line("END", "VCALENDAR"));
  return out.join("");
}
