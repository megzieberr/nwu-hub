// verify-reminders.mjs — unit tests for the send-push scheduling logic (../supabase/functions/
// send-push/reminders.mjs). These are the regression net the reminder rules had been missing: the
// SAST/45-min-window/dedupe/recurring-start decisions, exercised as pure predicates against an
// injected "now". Run: node sync/verify-reminders.mjs
import {
  saNow, saDateOf, dow, timeMin, hhmm,
  remindedToday, examRelevantToday, examDue, classOnToday, classDue,
  MORNING_MIN, CLASS_LEAD,
} from '../supabase/functions/send-push/reminders.mjs';

let fail = 0;
const ok = (name, cond, got) => { console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`); if (!cond) fail++; };

// A fixed "now": 2026-07-14 (a Tuesday), 10:30 SAST.
const now = { date: '2026-07-14', minutes: 10 * 60 + 30 };

// --- saNow / helpers ---------------------------------------------------------------------------
{
  const n = saNow(new Date('2026-07-14T08:30:00+02:00'));   // 08:30 SAST
  ok('saNow date is the SAST calendar day', n.date === '2026-07-14', n.date);
  ok('saNow minutes = 08:30 → 510', n.minutes === 510, n.minutes);
  // A UTC instant that is the next day in SAST (23:30Z = 01:30 SAST next day).
  const n2 = saNow(new Date('2026-07-14T23:30:00Z'));
  ok('saNow rolls to SAST next day at late UTC', n2.date === '2026-07-15' && n2.minutes === 90, n2);
  ok('saDateOf timestamptz → SAST date', saDateOf('2026-07-14T05:00:00Z') === '2026-07-14');
  ok('saDateOf null → null', saDateOf(null) === null);
  ok('dow(2026-07-14) = Tue(2)', dow('2026-07-14') === 2, dow('2026-07-14'));
  ok('timeMin 08:30:00 → 510', timeMin('08:30:00') === 510, timeMin('08:30:00'));
  ok('timeMin null → null', timeMin(null) === null);
  ok('hhmm 08:30:00 → 08:30', hhmm('08:30:00') === '08:30', hhmm('08:30:00'));
  ok('MORNING_MIN = 420, CLASS_LEAD = 45', MORNING_MIN === 420 && CLASS_LEAD === 45, [MORNING_MIN, CLASS_LEAD]);
}

// --- remindedToday (per-day dedupe) ------------------------------------------------------------
ok('remindedToday true when stamped today (SAST)', remindedToday('2026-07-14T06:00:00Z', now) === true);
ok('remindedToday false when stamped yesterday', remindedToday('2026-07-13T06:00:00Z', now) === false);
ok('remindedToday false when never', remindedToday(null, now) === false);

// --- examRelevantToday -------------------------------------------------------------------------
ok('exam dated today is relevant', examRelevantToday({ event_date: '2026-07-14', created_at: '2026-07-01T00:00:00Z' }, now) === true);
ok('exam dated another day is not', examRelevantToday({ event_date: '2026-07-20', created_at: '2026-07-01T00:00:00Z' }, now) === false);
ok('undated exam CREATED today is relevant (SALA exam-morning post)',
  examRelevantToday({ event_date: null, created_at: '2026-07-14T05:55:00Z' }, now) === true);
ok('undated exam created earlier is NOT relevant',
  examRelevantToday({ event_date: null, created_at: '2026-07-10T05:55:00Z' }, now) === false);

// --- examDue -----------------------------------------------------------------------------------
ok('exam due while register window still open (now 10:30 < close 10:59)',
  examDue({ code_close: '10:59:00' }, now) === true);
ok('exam NOT due once the window has closed (now 10:30 > close 09:00)',
  examDue({ code_close: '09:00:00' }, now) === false);
ok('windowless exam due from 07:00 on', examDue({ code_close: null }, now) === true);
ok('windowless exam NOT due before 07:00',
  examDue({ code_close: null }, { date: now.date, minutes: 6 * 60 + 30 }) === false);

// --- classOnToday (incl. the recurring-start guard — fix #1) ------------------------------------
// One-off: only on its exact date.
ok('one-off class on its date', classOnToday({ recurring: false, target_date: '2026-07-14' }, now) === true);
ok('one-off class not on another date', classOnToday({ recurring: false, target_date: '2026-07-15' }, now) === false);
// Recurring: same weekday AND the series has begun.
ok('recurring class on its weekday, already started', classOnToday({ recurring: true, target_date: '2026-07-07' }, now) === true, 'Tue past-start');
ok('recurring class on its weekday, starting TODAY', classOnToday({ recurring: true, target_date: '2026-07-14' }, now) === true, 'Tue same-day');
ok('recurring class on right weekday but series NOT started yet → NO reminder (fix #1)',
  classOnToday({ recurring: true, target_date: '2026-08-04' }, now) === false, 'future Tue start');
ok('recurring class on a different weekday → no', classOnToday({ recurring: true, target_date: '2026-07-08' }, now) === false, 'Wed');
ok('class with no target_date → no', classOnToday({ recurring: true, target_date: null }, now) === false);

// --- classDue ----------------------------------------------------------------------------------
// now = 10:30 (630 min). Window is (start-45, start].
ok('class due 45 min before (start 11:00)', classDue({ target_time: '11:00:00' }, now) === true);
ok('class due 1 min before (start 10:31)', classDue({ target_time: '10:31:00' }, now) === true);
ok('class NOT due 46 min before (start 11:16)', classDue({ target_time: '11:16:00' }, now) === false);
ok('class NOT due once it has started (start 10:30 → until 0)', classDue({ target_time: '10:30:00' }, now) === false);
ok('class NOT due after it started (start 10:00)', classDue({ target_time: '10:00:00' }, now) === false);
ok('time-less class due from 07:00 on', classDue({ target_time: null }, now) === true);
ok('time-less class NOT due before 07:00',
  classDue({ target_time: null }, { date: now.date, minutes: 6 * 60 + 30 }) === false);

console.log(fail ? `\n${fail} check(s) FAILED` : '\nAll reminder-scheduling checks passed.');
process.exit(fail ? 1 : 0);
