// NWU Study Hub — the reminder sender.
//
// One Edge Function that a pg_cron schedule calls every ~15 minutes (see PUSH-SETUP.md). Each run it
// finds what's DUE for the owner and pushes a reminder to her subscribed devices, then stamps
// `reminded_at` so nothing ever fires twice:
//   • CLASSES  (goals.kind='class')     — ~45 min before target_time on the class's day. Recurring
//                                          classes fire weekly on their weekday. No time → 07:00 nudge.
//   • EXAMS    (exam_access rows)        — fires on the first run that SEES a today's row (dated today,
//                                          or still-undated but created today — SALA posts the code the
//                                          exam morning) while the register window is still open. The
//                                          body carries the ACCESS CODE + register window, and the
//                                          notification deep-links to the Tests & Exams tab (#exams).
//   • TESTS    (goals.is_test=true)      — 07:00 SAST on target_date; SKIPPED when an exam_access row
//                                          already covers that module+date (the code reminder wins).
//
// Send { "test": true } (with the x-cron-secret header) to ping every subscribed device once, now.
// Runs on Deno; libraries via npm: specifiers. Uses the service role (bypasses RLS).

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:megzieberr@gmail.com";
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

const HUB_URL = "/nwu-hub/";
const EXAM_URL = "/nwu-hub/#exams";
const MORNING_MIN = 7 * 60;   // 07:00 SAST — the morning-of ping for tests & exams (and time-less classes)
const CLASS_LEAD = 45;        // minutes before a class to remind

// "Now" in South African time: today's date, and minutes-since-midnight. SAST is UTC+2, no DST.
function saNow() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hh = p.hour === "24" ? "00" : p.hour;           // Intl can emit "24" at midnight
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: parseInt(hh, 10) * 60 + parseInt(p.minute, 10),
  };
}

// The SAST calendar date of a timestamptz (for the "already reminded today?" check).
function saDateOf(ts: string | null): string | null {
  if (!ts) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts));
}

// Weekday of a YYYY-MM-DD, timezone-stable (0=Sun … 6=Sat). Used to place recurring classes.
function dow(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

// "HH:MM:SS" / "HH:MM" → minutes since midnight, or null.
function timeMin(t: string | null): number | null {
  if (typeof t !== "string") return null;
  const m = t.match(/^(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
// "HH:MM:SS" → "HH:MM" for display.
function hhmm(t: string | null): string {
  return typeof t === "string" ? t.slice(0, 5) : "";
}

type Sub = { id: string; owner: string; subscription: unknown };

// Send one payload to a set of subscriptions; drop any the push service reports as gone (404/410).
async function sendTo(subs: Sub[], payload: Record<string, unknown>) {
  let sent = 0, removed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(s.subscription as never, JSON.stringify(payload));
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await admin.from("push_subscriptions").delete().eq("id", s.id);
        removed++;
      }
    }
  }
  return { sent, removed };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("forbidden", { status: 401 });
  }
  let body: { test?: boolean } = {};
  try { body = await req.json(); } catch (_) { body = {}; }

  // Every subscribed device. This hub has ONE owner (Megan) whose schedule drives all reminders;
  // read-only viewers (Lize) who opt in get the SAME class/test/exam pings — Megan's call, and the
  // SALA exam codes are class-wide (the lecturer posts one for everyone), so nothing private leaks.
  const { data: subRows } = await admin.from("push_subscriptions").select("id, owner, subscription");
  const subs = (subRows ?? []) as Sub[];

  // --- Test mode: ping every device once. ---------------------------------
  if (body.test === true) {
    const res = await sendTo(subs, {
      title: "NWU Study Hub", body: "Reminders are on — you'll get a nudge before classes and on test mornings. 🔔",
      url: HUB_URL, tag: "nwu-hub-test",
    });
    return Response.json({ ok: true, mode: "test", devices: subs.length, ...res });
  }

  const now = saNow();
  let fired = 0;
  const sendAll = (payload: Record<string, unknown>) => sendTo(subs, payload);

  // --- EXAMS (exam_access) — the code-bearing reminder. -----------------------------------------
  // SALA posts the access code the exam MORNING, so the row usually lands ~08:00 (after the sync) with
  // NO date in the body. So we don't wait for a fixed 07:00 or insist event_date is set: fire on the
  // first run that sees a row for TODAY (event_date==today, or a still-undated row CREATED today) while
  // the register window hasn't closed — that gets the code onto her phone before the 08:30–08:59 slot.
  // (Residual: an evening-before post gets yesterday's date and won't match — can't be fixed from a
  // dateless body.) Track (owner|module|date) so a matching is_test goal stays quiet.
  const examCovered = new Set<string>();
  {
    const { data: exams } = await admin
      .from("exam_access")
      .select("id, owner, module_id, title, access_code, code_open, code_close, start_time, event_date, created_at, reminded_at, modules(code)")
      .or(`event_date.eq.${now.date},event_date.is.null`);
    for (const x of exams ?? []) {
      // Relevant today? A dated row must be dated today; an undated row must have been CREATED today
      // (SALA's exam-morning post) — this excludes historical undated rows and manual future exams.
      const relevant = x.event_date === now.date
        || (x.event_date === null && saDateOf(x.created_at) === now.date);
      if (!relevant) continue;

      // This exam owns today's sitting for dedup — record BEFORE the reminded check so a late-synced
      // is_test goal is suppressed even when the exam already fired on an earlier run this morning.
      const effDate = x.event_date ?? now.date;
      examCovered.add(`${x.owner}|${x.module_id}|${effDate}`);
      if (saDateOf(x.reminded_at) === now.date) continue;            // already reminded today

      // Fire while the register window is still open (now < code_close). No window known → 07:00 nudge.
      const closeMin = timeMin(x.code_close);
      const due = closeMin !== null ? now.minutes < closeMin : now.minutes >= MORNING_MIN;
      if (!due) continue;

      const code = x.access_code ? ` — code ${x.access_code}` : "";
      const win = x.code_open && x.code_close ? ` · register ${hhmm(x.code_open)}–${hhmm(x.code_close)}` : "";
      const write = x.start_time ? ` · write ${hhmm(x.start_time)}` : "";
      const modCode = (x.modules as { code?: string } | null)?.code ?? "";
      const res = await sendAll({
        title: `${modCode ? modCode + " " : ""}exam today`,
        body: `${x.title}${code}${win}${write}`.slice(0, 300),
        url: EXAM_URL, tag: `nwu-exam-${x.id}`,
      });
      if (res.sent > 0) {
        await admin.from("exam_access").update({ reminded_at: new Date().toISOString() }).eq("id", x.id);
        fired++;
      }
    }
  }

  // --- CLASSES (goals.kind='class') — ~45 min before, or a 07:00 nudge if no time. ---------------
  const { data: classGoals } = await admin
    .from("goals")
    .select("id, owner, text, target_date, target_time, recurring, reminded_at, modules(code)")
    .eq("kind", "class");
  for (const g of classGoals ?? []) {
    if (!g.target_date) continue;
    // Is today this class's day? Recurring → same weekday; one-off → the exact date.
    const onToday = g.recurring ? dow(g.target_date) === dow(now.date) : g.target_date === now.date;
    if (!onToday) continue;
    if (saDateOf(g.reminded_at) === now.date) continue;             // already reminded today

    const tmin = timeMin(g.target_time);
    let due = false;
    if (tmin === null) {
      due = now.minutes >= MORNING_MIN;                             // no time → morning nudge
    } else {
      const until = tmin - now.minutes;
      due = until > 0 && until <= CLASS_LEAD;                       // first tick within 45 min before
    }
    if (!due) continue;

    const when = g.target_time ? ` at ${hhmm(g.target_time)}` : "";
    const res = await sendAll({
      title: "Class reminder",
      body: `${g.text}${when}`.slice(0, 300),
      url: HUB_URL, tag: `nwu-class-${g.id}`,
    });
    if (res.sent > 0) {
      await admin.from("goals").update({ reminded_at: new Date().toISOString() }).eq("id", g.id);
      fired++;
    }
  }

  // --- TESTS without a code (goals.is_test) — 07:00 on target_date, unless an exam row covered it. -
  if (now.minutes >= MORNING_MIN) {
    const { data: tests } = await admin
      .from("goals")
      .select("id, owner, module_id, text, target_date, reminded_at")
      .eq("is_test", true).eq("target_date", now.date);
    for (const g of tests ?? []) {
      if (saDateOf(g.reminded_at) === now.date) continue;
      if (examCovered.has(`${g.owner}|${g.module_id}|${g.target_date}`)) {
        // The code-bearing exam reminder already went out for this sitting — stamp to stay quiet.
        await admin.from("goals").update({ reminded_at: new Date().toISOString() }).eq("id", g.id);
        continue;
      }
      const res = await sendAll({
        title: "Test today", body: `${g.text}`.slice(0, 300), url: HUB_URL, tag: `nwu-test-${g.id}`,
      });
      if (res.sent > 0) {
        await admin.from("goals").update({ reminded_at: new Date().toISOString() }).eq("id", g.id);
        fired++;
      }
    }
  }

  return Response.json({ ok: true, date: now.date, minutes: now.minutes, fired, devices: subs.length });
});
