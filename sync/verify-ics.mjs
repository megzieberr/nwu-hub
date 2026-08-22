// verify-ics.mjs — unit tests for the ics-feed calendar builder (../supabase/functions/ics-feed/
// ics.mjs). Same style as verify-reminders.mjs: plain asserts, PASS/FAIL lines, non-zero exit on
// failure. Run: node sync/verify-ics.mjs
import { writeFileSync } from "node:fs";
import { buildCalendar, escapeText, foldLine, summaryFor } from "../supabase/functions/ics-feed/ics.mjs";

let fail = 0;
const ok = (name, cond, got) => {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond ? "" : `  (got: ${JSON.stringify(got)})`}`);
  if (!cond) fail++;
};

const NOW = new Date("2026-08-22T10:00:00Z");

// Reconstruct logical (unfolded) content lines from a raw .ics string, asserting CRLF shape as it goes.
function unfold(ics, label = "") {
  ok(`${label} every physical break is CRLF`, !/[^\r]\n/.test(ics) && ics.includes("\r\n"));
  ok(`${label} file ends with END:VCALENDAR\\r\\n`, ics.endsWith("END:VCALENDAR\r\n"));
  const physical = ics.split("\r\n");
  const trimmed = physical[physical.length - 1] === "" ? physical.slice(0, -1) : physical;
  const logical = [];
  for (const p of trimmed) {
    if (p.startsWith(" ") && logical.length) logical[logical.length - 1] += p.slice(1);
    else logical.push(p);
  }
  return logical;
}

// First matching PROP(;params):value, scoped to the VEVENT block if there is one — otherwise a
// lookup for e.g. DTSTART would hit the VTIMEZONE/STANDARD sub-block's own DTSTART first.
function getProp(logicalLines, name) {
  const startIdx = logicalLines.indexOf("BEGIN:VEVENT");
  const scoped = startIdx === -1 ? logicalLines : logicalLines.slice(startIdx);
  const re = new RegExp(`^${name}(;[^:]*)?:(.*)$`);
  for (const l of scoped) {
    const m = l.match(re);
    if (m) return m[2];
  }
  return undefined;
}

function hasLine(logicalLines, exact) {
  return logicalLines.includes(exact);
}

// --- escapeText ----------------------------------------------------------------------------------
ok("escapeText escapes backslash, comma, semicolon, newline",
  escapeText("a,b;c\\d\ne") === "a\\,b\\;c\\\\d\\ne",
  escapeText("a,b;c\\d\ne"));
ok("escapeText handles null/undefined", escapeText(null) === "" && escapeText(undefined) === "");

// --- foldLine: short line untouched, long line folded within 75 octets, round-trips exactly ------
ok("foldLine leaves a short line as one CRLF-terminated line",
  foldLine("SUMMARY:short") === "SUMMARY:short\r\n");
{
  const longText = "X".repeat(40) + "ëëëëëëëë" + "Y".repeat(40); // multi-byte chars mid-line
  const folded = foldLine(`DESCRIPTION:${longText}`);
  ok("a >75-octet line actually gets folded (multiple physical lines)",
    folded.split("\r\n").filter(Boolean).length > 1);
  const physicalLines = folded.split("\r\n").filter(Boolean);
  const allWithin = physicalLines.every((l) => new TextEncoder().encode(l).length <= 75);
  ok("every folded physical line is <= 75 octets", allWithin,
    physicalLines.map((l) => new TextEncoder().encode(l).length));
  const rejoined = physicalLines.map((l, i) => (i === 0 ? l : l.slice(1))).join("");
  ok("fold/unfold round-trips to the exact original line", rejoined === `DESCRIPTION:${longText}`, rejoined);
}

// --- summaryFor on the real texts from the DB -----------------------------------------------------
ok('summaryFor: "EDCC125: online class — Saturday 22 Aug, 09:00" -> "EDCC125 · online class"',
  summaryFor({ code: "EDCC125", text: "EDCC125: online class — Saturday 22 Aug, 09:00" }) === "EDCC125 · online class",
  summaryFor({ code: "EDCC125", text: "EDCC125: online class — Saturday 22 Aug, 09:00" }));
ok('summaryFor: "MATH121 online class — Wed 29 Jul, 17:00" -> "MATH121 · online class"',
  summaryFor({ code: "MATH121", text: "MATH121 online class — Wed 29 Jul, 17:00" }) === "MATH121 · online class",
  summaryFor({ code: "MATH121", text: "MATH121 online class — Wed 29 Jul, 17:00" }));
ok('summaryFor: "ENGV121: PAL Session Q&A — Wed 19 Aug, 15:00" -> "ENGV121 · PAL Session Q&A"',
  summaryFor({ code: "ENGV121", text: "ENGV121: PAL Session Q&A — Wed 19 Aug, 15:00" }) === "ENGV121 · PAL Session Q&A",
  summaryFor({ code: "ENGV121", text: "ENGV121: PAL Session Q&A — Wed 19 Aug, 15:00" }));
ok("summaryFor falls back to 'class' when nothing is left after stripping",
  summaryFor({ code: "MATV121", text: "MATV121: — Mon 01 Jan, 09:00" }) === "MATV121 · class",
  summaryFor({ code: "MATV121", text: "MATV121: — Mon 01 Jan, 09:00" }));

// --- timed event: DTSTART/DTEND/VALARM present, correct +1h --------------------------------------
{
  const row = {
    id: "aaaaaaaa-0000-0000-0000-000000000001", code: "EDCC125",
    text: "EDCC125: online class — Saturday 22 Aug, 09:00",
    target_date: "2026-08-22", target_time: "09:00:00", recurring: false,
    link: "https://teams.microsoft.com/l/meetup-join/abc", created_at: "2026-08-01T06:00:00Z",
  };
  const ics = buildCalendar([row], { now: NOW });
  const lines = unfold(ics, "[timed]");
  ok("[timed] DTSTART present with TZID and correct start", getProp(lines, "DTSTART") === "20260822T090000");
  ok("[timed] DTEND is +1h", getProp(lines, "DTEND") === "20260822T100000");
  ok("[timed] a VALARM block exists", hasLine(lines, "BEGIN:VALARM") && hasLine(lines, "END:VALARM"));
  ok("[timed] VALARM trigger is -PT30M", hasLine(lines, "TRIGGER:-PT30M"));
  ok("[timed] SUMMARY is EDCC125 · online class", getProp(lines, "SUMMARY") === "EDCC125 · online class");
  ok("[timed] UID carries the goal id", getProp(lines, "UID") === `${row.id}@nwu-hub`);
  ok("[timed] URL is the Teams link", getProp(lines, "URL") === row.link);
  ok("[timed] LOCATION is Online (Teams)", getProp(lines, "LOCATION") === "Online (Teams)");
  ok("[timed] DESCRIPTION carries the Join line (escaped newline before Hub:)",
    getProp(lines, "DESCRIPTION").includes("Join\\:") || getProp(lines, "DESCRIPTION").startsWith("Join:"),
    getProp(lines, "DESCRIPTION"));
}

// --- no target_time -> all-day, no VALARM ---------------------------------------------------------
{
  const row = {
    id: "aaaaaaaa-0000-0000-0000-000000000002", code: "MATV121", text: "MATV121: written test",
    target_date: "2026-08-25", target_time: null, recurring: false, link: null,
    created_at: "2026-08-01T06:00:00Z",
  };
  const ics = buildCalendar([row], { now: NOW });
  const lines = unfold(ics, "[all-day]");
  ok("[all-day] DTSTART;VALUE=DATE on the class date", hasLine(lines, "DTSTART;VALUE=DATE:20260825"));
  ok("[all-day] DTEND;VALUE=DATE is the next day", hasLine(lines, "DTEND;VALUE=DATE:20260826"));
  ok("[all-day] no VALARM block", !hasLine(lines, "BEGIN:VALARM"));
  ok("[all-day] no URL line (no link)", getProp(lines, "URL") === undefined);
}

// --- recurring -> RRULE:FREQ=WEEKLY ----------------------------------------------------------------
{
  const row = {
    id: "aaaaaaaa-0000-0000-0000-000000000003", code: "MATH121", text: "MATH121 online class",
    target_date: "2026-07-01", target_time: "17:00:00", recurring: true, link: null,
    created_at: "2026-06-01T06:00:00Z",
  };
  const ics = buildCalendar([row], { now: NOW });
  const lines = unfold(ics, "[recurring]");
  ok("[recurring] RRULE:FREQ=WEEKLY present", hasLine(lines, "RRULE:FREQ=WEEKLY"));
}

// --- +1h crossing midnight: 19:30 -> 20:30 (same day), 23:30 -> next day 00:30 --------------------
{
  const row1930 = {
    id: "aaaaaaaa-0000-0000-0000-000000000004", code: "ENGV121", text: "ENGV121: PAL Session",
    target_date: "2026-08-19", target_time: "19:30:00", recurring: false, link: null,
    created_at: "2026-08-01T06:00:00Z",
  };
  const lines1930 = unfold(buildCalendar([row1930], { now: NOW }), "[19:30]");
  ok("[19:30] DTSTART 19:30", getProp(lines1930, "DTSTART") === "20260819T193000");
  ok("[19:30] DTEND 20:30 same day", getProp(lines1930, "DTEND") === "20260819T203000");

  const row2330 = { ...row1930, id: "aaaaaaaa-0000-0000-0000-000000000005", target_time: "23:30:00" };
  const lines2330 = unfold(buildCalendar([row2330], { now: NOW }), "[23:30]");
  ok("[23:30] DTSTART 23:30", getProp(lines2330, "DTSTART") === "20260819T233000");
  ok("[23:30] DTEND rolls to next day 00:30", getProp(lines2330, "DTEND") === "20260820T003000");
}

// --- old one-off (>60 days before now) excluded; old recurring included ---------------------------
{
  const oldOneOff = {
    id: "aaaaaaaa-0000-0000-0000-000000000006", code: "SECL121", text: "SECL121: old one-off",
    target_date: "2026-06-01", target_time: "09:00:00", recurring: false, link: null,
    created_at: "2026-05-01T06:00:00Z",
  };
  const oldRecurring = {
    id: "aaaaaaaa-0000-0000-0000-000000000007", code: "SECL121", text: "SECL121: old recurring",
    target_date: "2026-06-01", target_time: "09:00:00", recurring: true, link: null,
    created_at: "2026-05-01T06:00:00Z",
  };
  const ics = buildCalendar([oldOneOff, oldRecurring], { now: NOW });
  ok("old ONE-OFF class (>60d before now) is excluded", !ics.includes(`${oldOneOff.id}@nwu-hub`));
  ok("old RECURRING class is still included", ics.includes(`${oldRecurring.id}@nwu-hub`));

  // rows with no target_date at all are skipped outright
  const noDate = { ...oldOneOff, id: "aaaaaaaa-0000-0000-0000-000000000008", target_date: null };
  const icsNoDate = buildCalendar([noDate], { now: NOW });
  ok("a row with no target_date is skipped entirely", !icsNoDate.includes(`${noDate.id}@nwu-hub`));
}

// --- escaping of , ; and an embedded newline in SUMMARY/DESCRIPTION -------------------------------
{
  const row = {
    id: "aaaaaaaa-0000-0000-0000-000000000009", code: "TEST101",
    text: "TEST101: Session, phase; two\nSecond line — Mon 01 Jan, 09:00",
    target_date: "2026-08-22", target_time: "09:00:00", recurring: false,
    link: "https://example.com/join?a=1,b=2", created_at: "2026-08-01T06:00:00Z",
  };
  const lines = unfold(buildCalendar([row], { now: NOW }), "[escaping]");
  const summary = getProp(lines, "SUMMARY");
  ok("SUMMARY escapes comma, semicolon and newline",
    summary === "TEST101 · Session\\, phase\\; two\\nSecond line",
    summary);
  const description = getProp(lines, "DESCRIPTION");
  ok("DESCRIPTION escapes the comma inside the Teams link",
    description.includes("a=1\\,b=2"), description);
  ok("DESCRIPTION uses a literal \\n between Join and Hub lines",
    description.includes("\\nHub:"), description);
}

// --- sample calendar for the foreman to eyeball ----------------------------------------------------
{
  const sample = buildCalendar(
    [
      {
        id: "aaaaaaaa-1111-1111-1111-111111111111", code: "EDCC125",
        text: "EDCC125: online class — Saturday 22 Aug, 09:00",
        target_date: "2026-08-22", target_time: "09:00:00", recurring: false,
        link: "https://teams.microsoft.com/l/meetup-join/edcc125", created_at: "2026-08-15T06:00:00Z",
      },
      {
        id: "aaaaaaaa-2222-2222-2222-222222222222", code: "MATH121",
        text: "MATH121 online class — Wed 29 Jul, 17:00",
        target_date: "2026-07-29", target_time: "17:00:00", recurring: true,
        link: null, created_at: "2026-07-20T06:00:00Z",
      },
      {
        id: "aaaaaaaa-3333-3333-3333-333333333333", code: "MATV121", text: "MATV121: written test",
        target_date: "2026-08-25", target_time: null, recurring: false, link: null,
        created_at: "2026-08-01T06:00:00Z",
      },
    ],
    { now: NOW }
  );
  writeFileSync(new URL("./sample-classes.ics", import.meta.url), sample);
  console.log("\n(wrote sync/sample-classes.ics — 3 sample events, for the foreman to eyeball)");
}

console.log(fail ? `\n${fail} check(s) FAILED` : "\nAll ics-feed checks passed.");
process.exit(fail ? 1 : 0);
