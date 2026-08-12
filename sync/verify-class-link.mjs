// Regression net for class join links (classLink / groundedUrl / meetingUrlsIn in objectives.js).
//
// The bug this guards, found on 2026-08-12: the objectives agent INVENTED a Teams link. ALDE122's
// announcement said teams.microsoft.com/meet/388162619294849?p=nTweP8gPwRJ3xBWwVY, but the agent
// returned a teams.microsoft.com/l/meetup-join/... URL patterned on MATV121's real link from a month
// earlier, and validUrl() waved it through because the SHAPE was fine. A wrong join link is worse
// than none: she clicks it, lands nowhere, and misses the class trusting the hub.
//
// The second failure it guards: ENGV121's 14 July orientation link WAS in the announcement, but the
// agent returned null and it was lost. One unambiguous meeting URL in the body is now recovered.
//
// Run: node sync/verify-class-link.mjs   (no API key or network needed)
import { classLink, groundedUrl, meetingUrlsIn } from './class-link.mjs';

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`); }
}

// --- the real ALDE122 announcement fragment, verbatim from the live row (entities and all) ---
const ALDE_REAL = 'https://teams.microsoft.com/meet/388162619294849?p=nTweP8gPwRJ3xBWwVY';
const ALDE_BODY = `<h3>Link to Monday's information session @20:00: <a href="${ALDE_REAL}" rel="noopener noreferrer" target="_blank">Introduction to ALDE122_Edu students | Meeting-Join | Microsoft Teams</a></h3>`;
// what the agent actually stored that day
const HALLUCINATED = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_YTUyZjU1YjgtOWQ0Ny00YTk1LWI3YjAtYTk4OTJmNGQ0NWY0%40thread.v2/0?context=%7b%22Tid%22%3a%2240b64eeb-b3e2-47f1-9534-7edfa0db0c9e%22%7d';

console.log('the real 2026-08-12 ALDE122 case:');
ok('the hallucinated link is REJECTED', groundedUrl(HALLUCINATED, ALDE_BODY) === null);
ok('the real link is accepted', groundedUrl(ALDE_REAL, ALDE_BODY) === ALDE_REAL);
ok('classLink falls back to the real link when the model invents one',
  classLink(HALLUCINATED, ALDE_BODY) === ALDE_REAL, classLink(HALLUCINATED, ALDE_BODY));

console.log('\nENGV121 14 July — model returned null, link was in the body:');
const ENGV_REAL = 'https://teams.microsoft.com/meet/356578558736?p=9hRMDXMllLd9SEgAkr';
ok('a dropped link is recovered from the body', classLink(null, `<p>Join: <a href="${ENGV_REAL}">here</a></p>`) === ENGV_REAL);

console.log('\nMATV121 13 July — a real meetup-join link must still work:');
const MATV_REAL = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NDA1MjU4OTMtNjg0NC00NmQ1LWExNTgtY2QwMzU1ZmE5MTQ1%40thread.v2/0?context=%7b%22Tid%22%3a%22b14d86f1-83ba-4b13-a702-b5c0231b9337%22%7d';
ok('genuine meetup-join link accepted', groundedUrl(MATV_REAL, `<a href="${MATV_REAL}">Join</a>`) === MATV_REAL);

console.log('\nHTML entity encoding:');
// Sakai writes &amp; into body_html; the model hands back the decoded "&".
const AMP_REAL = 'https://zoom.us/j/123456?pwd=abc&role=1';
ok('&amp;-escaped body still matches the decoded URL',
  groundedUrl(AMP_REAL, `<a href="${AMP_REAL.replace(/&/g, '&amp;')}">Join</a>`) === AMP_REAL);

console.log('\nambiguity and junk:');
ok('TWO meeting links in the body -> no guess', (() => {
  const b = `<a href="https://zoom.us/j/1">a</a> <a href="https://zoom.us/j/2">b</a>`;
  return classLink(null, b) === null;
})());
ok('no meeting link in the body -> null', classLink(null, '<p>See eFundi for details.</p>') === null);
ok('a non-meeting URL is not offered as a join link',
  classLink(null, '<a href="https://efundi.nwu.ac.za/portal">eFundi</a>') === null);
ok('trailing full stop trimmed', meetingUrlsIn('Join https://zoom.us/j/999.')[0] === 'https://zoom.us/j/999');
ok('empty body is safe', classLink(null, '') === null && classLink(null, null) === null);
ok('malformed candidate rejected', groundedUrl('join the meeting', ALDE_BODY) === null);
ok('mailto rejected', groundedUrl('mailto:x@y.com', '<a href="mailto:x@y.com">mail</a>') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
