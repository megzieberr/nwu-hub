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
  // /direct/site.json is PAGINATED — this Sakai returns 10 sites per page by default, and
  // Megan is enrolled in more than that, so a single unpaged call silently dropped sites
  // (MATV121 never synced, 2026-07-12). Walk pages via EntityBroker's _limit/_start until
  // a page adds nothing new. The dedupe guard also stops the loop safely if this Sakai
  // ignores _start and keeps serving the same first page.
  const PAGE = 50;
  const out = [];
  const seen = new Set();
  for (let start = 0; start < 1000; start += PAGE) {
    const data = await getJson(client, `/direct/site.json?_limit=${PAGE}&_start=${start}`);
    const batch = data?.site_collection ?? [];
    let added = 0;
    for (const s of batch) {
      if (!s?.id || seen.has(s.id)) continue;
      seen.add(s.id);
      added++;
      out.push({ id: s.id, title: s.title ?? s.props?.Module ?? s.id });
    }
    if (!batch.length || !added) break;   // last page, or server repeating a page
  }
  return out;
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

// Some modules (e.g. ALDE122) deliver materials through the Lessons tool instead of Resources.
// Walk every lesson page and pull the embedded ContentHosting files (workbook/textbook/guides).
//   /direct/lessons/site/{siteId}.json      -> lessons_collection (each: id, lessonTitle)
//   /direct/lessons/lesson/{lessonId}.json  -> { contentsList: [ { sakaiId, name, type, url } ] }
// A real file is an item whose sakaiId is a ContentHosting path (/group|/private|/attachment/...).
// sourceId is the sakaiId itself — the SAME scheme fetchSiteContent uses — so a file that appears
// in both tools dedupes to one row (see index.js merge) instead of fighting over it.
export async function fetchSiteLessons(client, siteId) {
  const site = await getJson(client, `/direct/lessons/site/${siteId}.json`, { timeout: 60000 });
  const lessons = site?.lessons_collection ?? [];
  const out = [];
  const seen = new Set();

  // Files can sit at ANY depth: lecturers who build Lessons out of subpages get those
  // subpages INLINED into the lesson JSON as nested contentsList arrays (MATV121 keeps its
  // study guides two levels down; a top-level-only walk sees just banners and separators).
  // Depth cap guards against a pathological self-referencing page.
  const walk = (items, depth = 0) => {
    if (!Array.isArray(items) || depth > 10) return;
    for (const it of items) {
      if (Array.isArray(it?.contentsList)) walk(it.contentsList, depth + 1);   // inlined subpage
      const sid = typeof it?.sakaiId === 'string' ? it.sakaiId : '';
      if (!/^\/(group|private|attachment)\//.test(sid)) continue;   // embedded file only
      if (seen.has(sid)) continue;
      seen.add(sid);
      const title = it.name || decodeURIComponent(sid.split('/').pop() || '') || 'file';
      out.push({
        sourceId: sid,
        title,
        mime: it.contentType || mimeFromName(title),   // Lessons items carry contentType
        size: null,                    // not exposed by the Lessons API; buf.length used after download
        lastModified: null,
        url: `${EFUNDI}/access/content` + sid.split('/').map(encodeURIComponent).join('/'),
      });
    }
  };

  for (const L of lessons) {
    const page = await getJson(client, `/direct/lessons/lesson/${L.id}.json`, { timeout: 60000 });
    walk(page?.contentsList);
  }
  return out.filter(f => !isVideo(f.mime, f.title, f.url));
}

function mimeFromName(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return {
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }[ext] || null;
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
