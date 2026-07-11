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

async function getJson(client, path) {
  const res = await client.get(`${EFUNDI}${path}`, { timeout: { request: 30000 } });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }   // HTML/error page -> null
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
    bodyHtml: a.body ?? null,
    postedAt: a.createdOn ? new Date(Number(a.createdOn)).toISOString() : null,
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

function assignmentDueDate(a) {
  const epoch = a?.dueTime?.epochSecond;
  if (epoch) return new Date(Number(epoch) * 1000).toISOString().slice(0, 10);
  if (typeof a?.dueTimeString === 'string') return a.dueTimeString.slice(0, 10);
  return null;
}

export async function fetchSiteContent(client, siteId) {
  const data = await getJson(client, `/direct/content/site/${siteId}.json`);
  return (data?.content_collection ?? [])
    // keep files only; skip folders/collections
    .filter(c => (c.type ?? c.mimeType) && (c.type ?? c.mimeType) !== 'collection' && (c.resourceType !== 'collection'))
    .map(c => ({
      sourceId: c.resourceId ?? c.id ?? c.url,
      title: c.name ?? c.title ?? 'file',
      mime: c.type ?? c.mimeType ?? null,
      size: numOrNull(c.size ?? c.contentLength),
      lastModified: c.lastModified ?? c.modifiedDate ?? null,
      url: absoluteUrl(c.url),
    }));
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
