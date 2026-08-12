// class-link.mjs — deciding which join link a class goal gets.
//
// Lives apart from objectives.js so the regression net (sync/verify-class-link.mjs) can import it
// without pulling in the Anthropic SDK, which is only installed in CI. Same arrangement as
// supabase/functions/send-push/reminders.mjs: the pure decisions sit where a test can reach them,
// and the caller imports the very same code that runs in production.

// Only accept real http(s) URLs; anything else (a stray sentence, a mailto, null) -> no link.
export function validUrl(u) {
  return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null;
}

// body_html escapes URL characters ("&" -> "&amp;") and the model hands back the decoded form, so
// both sides must be decoded before they can be compared.
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');
}

// Meeting hosts we recognise, for the "the model dropped the link" fallback below.
const MEETING_HOSTS = /^https?:\/\/(?:[\w-]+\.)*(?:teams\.microsoft\.com|teams\.live\.com|zoom\.us|meet\.google\.com|webex\.com)\//i;

// meetingUrlsIn — every distinct meeting URL that literally appears in an announcement.
export function meetingUrlsIn(bodyHtml) {
  const hay = decodeEntities(bodyHtml);
  const found = hay.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
  const out = [];
  for (let u of found) {
    u = u.replace(/[.,;:]+$/, '');              // trailing sentence punctuation
    if (!MEETING_HOSTS.test(u)) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

// groundedUrl — a link is only trusted if it ACTUALLY APPEARS in the announcement.
//
// Why this exists: validUrl checks the shape only, and a hallucinated URL is perfectly shaped. On
// 2026-08-12 the agent returned a plausible teams.microsoft.com/l/meetup-join/... URL for ALDE122's
// Monday session — patterned on MATV121's real link from a month earlier — when the announcement
// actually said teams.microsoft.com/meet/388162619294849?p=... A wrong join link is worse than no
// link: she clicks it, lands nowhere, and misses the class believing the hub had her covered.
export function groundedUrl(candidate, bodyHtml) {
  const u = validUrl(candidate);
  if (!u) return null;
  const hay = decodeEntities(bodyHtml);
  if (hay.includes(u)) return u;
  if (hay.includes(u.replace(/\/+$/, ''))) return u;      // stored with a trailing slash
  return null;
}

// classLink — the join link for a class goal: the model's, if it is really in the announcement;
// otherwise the announcement's own meeting URL when there is exactly one, so there is no ambiguity
// about which class it belongs to. That second half recovers the other observed failure — ENGV121's
// 14 July orientation link was in the body but the agent returned null and it was lost.
export function classLink(candidate, bodyHtml) {
  const grounded = groundedUrl(candidate, bodyHtml);
  if (grounded) return grounded;
  const inBody = meetingUrlsIn(bodyHtml);
  return inBody.length === 1 ? inBody[0] : null;
}
