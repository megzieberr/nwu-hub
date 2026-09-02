// verify-synchealth.mjs — regression net for src/lib/synchealth.js, the header sync-health line.
// The decisions that matter: when does a quiet sync become an ALARM, and does the timestamp read
// in South African time (the sync's own clock) rather than the browser's or UTC's.
// Run: node sync/verify-synchealth.mjs   (exit 0 = all green)
import { syncHealthView, syncFailure, STALE_HOURS } from '../src/lib/synchealth.js'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

// A fixed "now": Wednesday 2026-09-02, 08:00 SAST (= 06:00Z). The morning she opens the hub.
const NOW = new Date('2026-09-02T08:00:00+02:00')

// ---- fresh, earlier the same SAST day -----------------------------------------------------
// 06:12 SAST today, seen at 08:00 → under two hours old, and no weekday needed.
check('fresh today: bare HH:MM, no weekday',
  syncHealthView('2026-09-02T06:12:00+02:00', NOW),
  { state: 'ok', label: 'eFundi synced 06:12' })

// ---- yesterday evening, still inside the window -------------------------------------------
// The real overnight case: last night's 19:03 run, opened at 08:00 — about 13 hours, so the sync
// is late but not yet alarming. This is the boundary that decides whether Megan gets an amber
// pill every single morning (she must not).
check(`yesterday 19:03 seen at 08:00 is under ${STALE_HOURS}h, so still ok`,
  syncHealthView('2026-09-01T19:03:00+02:00', NOW),
  { state: 'ok', label: 'eFundi synced Tue 19:03' })

// ---- past the threshold --------------------------------------------------------------------
// 14.5 hours back = 17:30 SAST yesterday.
check('14.5h old is stale, and says "last synced"',
  syncHealthView('2026-09-01T17:30:00+02:00', NOW),
  { state: 'stale', label: 'eFundi last synced Tue 17:30' })

// Exactly on the threshold counts as stale (>= not >): 18:00 SAST yesterday is 14h before 08:00.
check(`exactly ${STALE_HOURS}h is already stale (boundary)`,
  syncHealthView('2026-09-01T18:00:00+02:00', NOW).state, 'stale')
// One minute inside it is not.
check(`${STALE_HOURS}h less a minute is still ok`,
  syncHealthView('2026-09-01T18:01:00+02:00', NOW).state, 'ok')

// A sync that has been quiet for days still reads as one calm line, not a pile-up.
check('days quiet: still one stale line, weekday-stamped',
  syncHealthView('2026-08-31T06:00:00+02:00', NOW),
  { state: 'stale', label: 'eFundi last synced Mon 06:00' })

// ---- nothing on record ----------------------------------------------------------------------
// last_ok is null when efundi_sync_runs holds no successful run at all. Not an error state — the
// pill still shows, because "never synced" is exactly as wrong as "synced two days ago".
check('null → never', syncHealthView(null, NOW),
  { state: 'never', label: 'eFundi has not synced yet' })
check('undefined → never', syncHealthView(undefined, NOW).state, 'never')
check('a garbled timestamp reads as never, not as NaN hours',
  syncHealthView('not a date', NOW), { state: 'never', label: 'eFundi has not synced yet' })

// ---- the today/weekday switch ---------------------------------------------------------------
// The switch is on the SAST CALENDAR DAY, not on "less than 24 hours ago". A run at 23:50 last
// night is only ~8 minutes old at 00:00 but belongs to yesterday, so it must carry its weekday.
const JUST_AFTER_MIDNIGHT = new Date('2026-09-02T00:00:00+02:00')
check('minutes old but yesterday: keeps the weekday',
  syncHealthView('2026-09-01T23:50:00+02:00', JUST_AFTER_MIDNIGHT),
  { state: 'ok', label: 'eFundi synced Tue 23:50' })
// ...and the same instant seen later on its own day drops the weekday again.
check('same instant, same day: no weekday',
  syncHealthView('2026-09-02T00:05:00+02:00', new Date('2026-09-02T09:00:00+02:00')).label,
  'eFundi synced 00:05')

// ---- the UTC/SAST date boundary --------------------------------------------------------------
// 23:30 UTC is 01:30 SAST the NEXT day. Formatted off UTC this would read "Tue 23:30" — a whole
// day and two hours wrong. Both the time and the day must be the South African ones.
check('23:30Z stamps as 01:30 on the SAST next day (same day as now → no weekday)',
  syncHealthView('2026-09-01T23:30:00Z', NOW),
  { state: 'ok', label: 'eFundi synced 01:30' })
// The mirror: an instant that is still "today" in UTC but already yesterday in SAST cannot happen
// (SAST is ahead), so the risky direction is the one above. Guard the stale reading of it too —
// same instant, seen that evening, is over 14h old and must keep the SAST day it happened on.
check('the same 23:30Z instant seen that SAST evening is stale, still stamped 01:30',
  syncHealthView('2026-09-01T23:30:00Z', new Date('2026-09-02T18:00:00+02:00')),
  { state: 'stale', label: 'eFundi last synced 01:30' })
// And once a further day has passed it picks up its SAST weekday (Wed, not Tue).
check('crossed-midnight instant carries its SAST weekday a day later',
  syncHealthView('2026-09-01T23:30:00Z', new Date('2026-09-03T09:00:00+02:00')).label,
  'eFundi last synced Wed 01:30')

// ---- clock skew --------------------------------------------------------------------------------
// A device clock running behind makes the last sync look like the future. That must read as fresh;
// a wrong watch must never invent an alarm.
check('a future timestamp reads ok, never stale',
  syncHealthView('2026-09-02T10:00:00+02:00', NOW).state, 'ok')

// ---- the copy ------------------------------------------------------------------------------------
// House rule: no em-dashes anywhere Megan might read them, and the two wordings must differ so the
// amber pill does not read like the quiet line.
for (const [n, v] of [
  ['ok', syncHealthView('2026-09-02T06:12:00+02:00', NOW)],
  ['stale', syncHealthView('2026-09-01T17:30:00+02:00', NOW)],
  ['never', syncHealthView(null, NOW)],
]) {
  check(`copy: ${n} label has no em-dash`, /[—–]/.test(v.label), false)
  check(`copy: ${n} state matches its label voice`, v.state, n)
}

// ---- syncFailure: the OTHER surface (the banner) ------------------------------------------------
// Megan's 2026-09-02 ruling folded the two freshness indicators into one, so this half now answers
// only "did the last run fail?" and never touches the clock. These checks exist mostly to keep the
// two halves from drifting back into one another.
check('a clean run says nothing', syncFailure({ status: 'ok' }), null)
check('auth_failed → auth', syncFailure({ status: 'auth_failed' }), 'auth')
check('error → error', syncFailure({ status: 'error' }), 'error')
check('no run row at all → nothing to say', syncFailure(null), null)
check('an unknown future status is not treated as a failure', syncFailure({ status: 'queued' }), null)

// partial is the one this fold could have silently dropped: it was ONLY ever visible on the panel
// line that is now gone, and it is not 'ok', so it never refreshes last_ok either. If this check
// fails, a half-finished sync has gone completely quiet again.
check('partial → partial (the surface the retired panel line used to own)',
  syncFailure({ status: 'partial' }), 'partial')

// The two halves must stay independent: a FRESH run that failed still reports its failure, and a
// STALE-but-clean history still reports none. This is the whole reason there are two functions.
const failedJustNow = { status: 'error', finished_at: '2026-09-02T07:55:00+02:00' }
check('a failure five minutes old is still a failure (the header would read fresh)',
  [syncFailure(failedJustNow), syncHealthView('2026-09-02T06:12:00+02:00', NOW).state],
  ['error', 'ok'])
check('a long-stale but never-failed sync is the header\'s business, not the banner\'s',
  [syncFailure({ status: 'ok' }), syncHealthView('2026-08-31T06:00:00+02:00', NOW).state],
  [null, 'stale'])

// Staleness moved OUT of this half. Nothing about an old timestamp may make it speak.
check('an ancient clean run does not make the banner fire',
  syncFailure({ status: 'ok', finished_at: '2026-08-01T06:00:00+02:00' }), null)

console.log(`${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
