// verify-exam-extract.mjs — checks parseExamAccess against the real SALA template (from the plan's
// MATH111 sample) plus negative cases. Run: node sync/verify-exam-extract.mjs
import { parseExamAccess, resolveEventDate } from './exam-parse.js';

let fail = 0;
const ok = (name, cond, got) => { console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`); if (!cond) fail++; };

const today = '2026-07-14';

// --- SALA "Exam opportunity" body shape (values are FAKE — this repo is public) ---
const title = 'DEMO101 Exam opportunity 2 - (QR code attached)';
const body = 'Dear students, your exam opportunity is scheduled for 22 July 2026. '
  + 'Exam QR Access Code: aaaa1111 . You must enter this code in the Invigilator Web Browser Agent. '
  + 'The QR Code will open at 08:30 and close at 08:59. '
  + 'The assessment will be available at 09:00 under eFundi Assignments. '
  + 'Link: https://efundi.nwu.ac.za/x/EXAMPLE . Good luck.';

const r = parseExamAccess(title, body, today);
ok('parses (returns a row)', !!r, r);
if (r) {
  ok('access_code extracted', r.access_code === 'aaaa1111', r.access_code);
  ok('title stripped of "(QR code attached)"', r.title === 'DEMO101 Exam opportunity 2', r.title);
  ok('code_open = 08:30:00', r.code_open === '08:30:00', r.code_open);
  ok('code_close = 08:59:00', r.code_close === '08:59:00', r.code_close);
  ok('start_time = 09:00:00', r.start_time === '09:00:00', r.start_time);
  ok('event_date = 2026-07-22', r.event_date === '2026-07-22', r.event_date);
  ok('efundi_url captured, no trailing punctuation', r.efundi_url === 'https://efundi.nwu.ac.za/x/EXAMPLE', r.efundi_url);
  ok('kind = exam', r.kind === 'exam', r.kind);
}

// --- variants ---
const t2 = parseExamAccess('STAT121 Test opportunity', 'Exam QR Access Code: bbbb2222. Opens at 10h00 and will close at 10h29.', today);
ok('h-separator time parses (10h00 -> 10:00:00)', t2 && t2.code_open === '10:00:00', t2 && t2.code_open);
ok('test-titled -> kind=test', t2 && t2.kind === 'test', t2 && t2.kind);

const isoDate = parseExamAccess('X', 'Exam QR Access Code: deadbeef on 2026-09-01.', today);
ok('ISO date parses', isoDate && isoDate.event_date === '2026-09-01', isoDate && isoDate.event_date);

// --- the REAL SALA body has NO date -> event_date must be null (the bug the fixture above hid) ---
// (values fake; shape mirrors the actual MATH111 "Exam opportunity" announcement, which carries no date)
const dateless = 'Dear students. Exam QR Access Code: cccc3333 . Enter this code in the Invigilator Web '
  + 'Browser Agent. The QR Code will open at 08:30 and close at 08:59. The assessment will be available '
  + 'at 09:00 under eFundi Assignments. Link: https://efundi.nwu.ac.za/x/EXAMPLE2 . Good luck.';
const dl = parseExamAccess('MATH111 Exam opportunity 2 - (QR code attached)', dateless, today);
ok('dateless real body still parses (has the code)', !!dl && dl.access_code === 'cccc3333', dl && dl.access_code);
ok('dateless real body -> event_date = null', dl && dl.event_date === null, dl && dl.event_date);

// --- resolveEventDate: null parsed date falls back to the posted date (in SAST) ---
ok('resolveEventDate keeps a parsed date', resolveEventDate('2026-07-22', '2026-07-20T06:00:00Z') === '2026-07-22');
ok('resolveEventDate falls back to posted SAST date',
  resolveEventDate(null, '2026-07-22T05:30:00Z') === '2026-07-22',   // 05:30Z = 07:30 SAST, same day
  resolveEventDate(null, '2026-07-22T05:30:00Z'));
ok('resolveEventDate late-night post stays on its SAST day',
  resolveEventDate(null, '2026-07-21T22:30:00Z') === '2026-07-22',   // 22:30Z = 00:30 SAST next day
  resolveEventDate(null, '2026-07-21T22:30:00Z'));
ok('resolveEventDate null + no posted date -> null', resolveEventDate(null, null) === null);

// --- negatives (must NOT create a row) ---
ok('ordinary announcement -> null', parseExamAccess('Welcome to the module', 'Please read the study guide. No exam yet.', today) === null);
ok('mentions exam but no code -> null', parseExamAccess('Exam info', 'Your exam is on 22 July at 09:00.', today) === null);

console.log(fail ? `\n${fail} check(s) FAILED` : '\nAll exam-extract checks passed.');
process.exit(fail ? 1 : 0);
