// fetch-efundi.js — pull content from the Sakai /direct/ JSON API using the
// authenticated `got` client from auth.js, and normalize into source-agnostic shapes.
//
// Endpoints confirmed working in Phase 0 (docs/efundi-sync-recon.md):
//   /direct/site.json                         -> enrolled sites (id + title)
//   /direct/announcement/site/{siteId}.json   -> announcements (+ lecturer mark-lists)
//   /direct/assignment/site/{siteId}.json     -> assignments (due dates, attachments)
//   /direct/content/site/{siteId}.json        -> files in the Resources tool
//
// NOTE: the recon site had no files, so the content_collection field names below are the
// standard Sakai ContentResource keys read defensively. Verify on the first real dispatch
// run (the sample site with study guides) and tighten if a field name differs.

const EFUNDI = 'https://efundi.nwu.ac.za';

async function getJson(client, path, { timeout = 60000, retries = 0 } = {}) {
  // Non-fatal: a slow/failed endpoint yields null (-> [] upstream), never crashes the run.
  // eFundi is flaky under load, so slow/heavy endpoints (content) get a longer budget + a retry.
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await client.get(`${EFUNDI}${path}`, { timeout: { request: timeout } });
      if (res.statusCode !== 200) { console.warn(`    fetch ${path} -> HTTP ${res.statusCode}`); return null; }
      return JSON.parse(res.body);            // HTML/error page -> caught below
    } catch (e) {
      const willRetry = attempt < retries;
      console.warn(`    fetch ${path} failed (attempt ${attempt + 1}/${retries + 1}): ${e.message}${willRetry ? ' — retrying' : ''}`);
      if (!willRetry) return null;
    }
  }
  return null;
}

function absoluteUrl(u) {
  if (!u) return null;
  return u.startsWith('http') ? u : `${EFUNDI}${u.startsWith('/') ? '' : '/'}${u}`;
}

export async function listSites(client) {
  const data = await getJson(client, '/direct/site.json');
  return (data?.site_collection ?? []).map(s => ({
    id: s.id,
    title: s.title ?? s.props?.Module ?? s.id,
  }));
}

export async function fetchSiteAnnouncements(client, siteId) {
  const data = await getJson(client, `/direct/announcement/site/${siteId}.json`);
  return (data?.announcement_collection ?? []).map(a => ({
    sourceId: a.id ?? a.announcementId,
    title: a.title ?? '(untitled)',
    bodyHtml: a.body ?? a.text ?? null,
    // toIso never throws on an unexpected date shape — a bad date must not sink the site.
    postedAt: toIso(a.createdOn ?? a.date ?? a.modifiedDate),
  }));
}

export async function fetchSiteAssignments(client, siteId) {
  const data = await getJson(client, `/direct/assignment/site/${siteId}.json`);
  return (data?.assignment_collection ?? []).map(a => ({
    sourceId: a.id,
    title: a.title ?? '(untitled)',
    dueDate: assignmentDueDate(a),
  }));
}

// Sakai serialises the due date differently across versions/tools:
//   {epochSecond}, {time: ms}, a bare epoch, an ISO string, or a preformatted dueTimeString.
// Try each; toDay tolerates all of them and never throws.
function assignmentDueDate(a) {
  return toDay(a?.dueTime) ?? toDay(a?.dueDate) ?? toDay(a?.dueTimeString) ?? null;
}

export async function fetchSiteContent(client, siteId) {
  // The content listing is the heaviest /direct response and the first to time out when eFundi
  // is slow — give it a longer budget and one retry (observed: 60s single-shot fails under load).
  const data = await getJson(client, `/direct/content/site/${siteId}.json`, { timeout: 150000, retries: 1 });
  return (data?.content_collection ?? [])
    .filter(c => !isCollection(c))     // keep files only; skip folders/collections
    .map(c => ({
      sourceId: c.resourceId ?? c.id ?? c.url,
      title: c.name ?? c.title ?? 'file',
      mime: c.type ?? c.mimeType ?? null,
      size: numOrNull(c.size ?? c.contentLength),
      lastModified: c.lastModified ?? c.modifiedDate ?? null,
      url: absoluteUrl(c.url),
    }))
    // Never mirror videos — the owner transcribes the relevant ones by hand, so a copy in the
    // hub is pure waste (and they're big). Skip by mime OR extension.
    .filter(f => !isVideo(f.mime, f.title, f.url));
}

export const VIDEO_RE = /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv|mpe?g|3gp|ogv|ts)$/i;
export function isVideo(mime, ...names) {
  if (typeof mime === 'string' && mime.toLowerCase().startsWith('video/')) return true;
  return names.some(n => typeof n === 'string' && VIDEO_RE.test(n));
}

// TEMP diagnostic: dump the Lessons-tool structure so we can see how a lesson references its
// embedded files (workbook/textbook/etc.) and design the real Lessons sync.
export async function diagnoseSite(client, siteId) {
  try {
    const res = await client.get(`${EFUNDI}/direct/lessons/site/${siteId}.json`, { timeout: { request: 30000 } });
    const lessons = (JSON.parse(res.body)?.lessons_collection) ?? [];
    console.log(`    [diag] lessons_collection: ${lessons.length} lesson(s)`);
    for (const L of lessons.slice(0, 8)) {
      console.log(`    [diag] lesson id=${L.id} title=${JSON.stringify(L.lessonTitle)}`);
      try {
        const r2 = await client.get(`${EFUNDI}/direct/lessons/lesson/${L.id}.json`, { timeout: { request: 30000 } });
        console.log(`    [diag]   items: ${String(r2.body || '').replace(/\s+/g, ' ').slice(0, 600)}`);
      } catch (e) { console.log(`    [diag]   items ERR ${e.message}`); }
    }
  } catch (e) { console.log(`    [diag] lessons probe ERR ${e.message}`); }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Is this content entry a folder/collection rather than a file? Sakai marks folders several
// ways depending on version; check all the common ones so a folder never gets mirrored as a file.
function isCollection(c) {
  const t = c.type ?? c.mimeType;
  if (t === 'collection') return true;
  if (c.container === true) return true;
  if (typeof c.resourceType === 'string' && /folder|collection/i.test(c.resourceType)) return true;
  if (typeof c.url === 'string' && c.url.endsWith('/')) return true;
  if (typeof c.resourceId === 'string' && c.resourceId.endsWith('/')) return true;
  return false;
}

// Robust date parsing for Sakai's mixed encodings — returns a Date or null, NEVER throws.
// Accepts: ms-epoch number/string, seconds-epoch, {epochSecond|epochMilli|time}, ISO/date string.
function toDate(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v.epochSecond != null) return toDate(Number(v.epochSecond) * 1000);
    if (v.epochMilli  != null) return toDate(Number(v.epochMilli));
    if (v.time        != null) return toDate(Number(v.time));
    return null;
  }
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {                       // all-digits => epoch
    let n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < 1e12) n *= 1000;                   // seconds -> ms
    const d = new Date(n);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);                        // ISO / parseable string
  return isNaN(d.getTime()) ? null : d;
}
const toIso = v => { const d = toDate(v); return d ? d.toISOString() : null; };
// Date-only (YYYY-MM-DD). Pass through an already-date-prefixed string untouched (no tz shift).
function toDay(v) {
  if (typeof v === 'string') { const m = v.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; }
  const d = toDate(v);
  return d ? d.toISOString().slice(0, 10) : null;
}
