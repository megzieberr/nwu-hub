// The sync health line — is eFundi still coming in, and when did it last land?
//
// Why this exists: GitHub's scheduler quietly stopped firing the sync for six days
// (PLAN-sync-trigger.md §1) and nothing shouted. Every run that DID fire succeeded, so a
// last-run-failed check could never have caught it — the only signal is the AGE of the newest
// successful run. Megan's phone refuses push notifications, so the hub itself is the alarm: she
// opens it many times a day, and a stale sync now shows as an amber pill in the header.
//
// Same arrangement as week.js and quests.js: Node cannot import .jsx, so the decision and its
// wording live here as pure functions with `now` injectable, and sync/verify-synchealth.mjs is
// the regression net. The component (src/SyncHealth.jsx) only fetches and renders.

// The sync fires every 4 hours (pg_cron, with a daily GitHub backstop). 14 hours is roughly
// three missed slots — long enough that a single late or skipped run is not an alarm, short
// enough that a whole quiet night is.
export const STALE_HOURS = 14

// All times are South African (UTC+2, no DST). Intl carries the zone; the weekday name is
// hand-rolled off the resulting date string so it cannot wobble with ICU/locale data between the
// browser and the Node test run (the week.js rule). Client-side twin of send-push/reminders.mjs
// saNow/saDateOf — deliberately a copy, since a Deno edge function is not importable from here.
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function saParts(d) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
  const hh = p.hour === '24' ? '00' : p.hour        // Intl can emit "24" at midnight
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hh}:${p.minute}` }
}

// Weekday of a YYYY-MM-DD, timezone-stable (0=Sun … 6=Sat) — the reminders.mjs dow().
function dow(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay()
}

// '12:04' if it happened on today's SAST calendar day, else 'Tue 19:03'. Both sides are compared
// as SAST dates, so an instant late in the UTC evening (23:30Z = 01:30 SAST the next day) is
// stamped with the day Megan would call it, not the UTC one.
function saStamp(then, now) {
  const t = saParts(then)
  return t.date === saParts(now).date ? t.time : `${WD[dow(t.date)]} ${t.time}`
}

// The whole decision: given when the sync last SUCCEEDED, what should the header say?
//   never — no successful run on record (an empty table, or a garbled timestamp)
//   ok    — landed less than STALE_HOURS ago; a quiet, muted line
//   stale — STALE_HOURS or older; the amber warning
export function syncHealthView(lastOkIso, now = new Date()) {
  if (!lastOkIso) return { state: 'never', label: 'eFundi has not synced yet' }
  const then = new Date(lastOkIso)
  if (isNaN(then.getTime())) return { state: 'never', label: 'eFundi has not synced yet' }
  // A clock skewed into the future reads as fresh, never as stale — a wrong device clock must
  // not invent an alarm.
  const hours = (now.getTime() - then.getTime()) / 3600000
  const when = saStamp(then, now)
  return hours >= STALE_HOURS
    ? { state: 'stale', label: `eFundi last synced ${when}` }
    : { state: 'ok', label: `eFundi synced ${when}` }
}
