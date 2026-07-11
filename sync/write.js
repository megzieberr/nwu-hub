// write.js — the privileged half. Connects with the Supabase SERVICE ROLE (bypasses RLS),
// so it MUST set `owner` explicitly on every insert and only ever touch Megan's own rows.
//
// Dedupe: each item gets a source_hash of its meaningful fields. We load the existing
// (source_id -> source_hash) map per table up front, then:
//   • not seen before      -> insert  (counts as NEW)
//   • seen but hash differs -> update  (counts as UPDATED)
//   • seen, hash same       -> skip
// Idempotent: safe to re-run a half-finished sync.

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export function makeSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (check Actions Secrets).');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

const VIDEO_RE = /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv|mpe?g|3gp|ogv|ts)$/i;

// Enforce "no videos in the hub": remove any eFundi-sourced video files (storage object + row).
// Scoped to source='efundi' so the owner's own manual uploads are never touched. Runs each sync
// as a cheap invariant (no-op once clean) — a belt-and-suspenders alongside the fetch-side skip.
export async function purgeVideos(sb) {
  const { data, error } = await sb.from('resources').select('id, storage_path, title').eq('source', 'efundi');
  if (error) { console.warn(`purgeVideos: ${error.message}`); return 0; }
  const vids = (data ?? []).filter(r => VIDEO_RE.test(r.title || '') || VIDEO_RE.test(r.storage_path || ''));
  if (!vids.length) return 0;
  const paths = vids.map(r => r.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: se } = await sb.storage.from('resources').remove(paths);
    if (se) console.warn(`purgeVideos storage remove: ${se.message}`);
  }
  const { error: de } = await sb.from('resources').delete().in('id', vids.map(r => r.id));
  if (de) { console.warn(`purgeVideos row delete: ${de.message}`); return 0; }
  console.log(`  purged ${vids.length} video file(s) from the hub.`);
  return vids.length;
}

// Resolve the owner uid without touching auth admin: every module row is Megan's.
export async function resolveOwner(sb) {
  const { data, error } = await sb.from('modules').select('owner').limit(1).single();
  if (error || !data?.owner)
    throw new Error('Cannot resolve owner (no modules seeded?): ' + (error?.message ?? 'no rows'));
  return data.owner;
}

export async function loadSiteMap(sb) {
  const { data, error } = await sb.from('efundi_site_map')
    .select('efundi_site_id, module_id, active').eq('active', true);
  if (error) throw error;
  const map = new Map();
  for (const r of data ?? []) if (r.module_id) map.set(r.efundi_site_id, r.module_id);
  return map;
}

// autoMapSites — map newly-visible eFundi sites to modules by title, so a lecturer opening a
// course site mid-semester starts syncing on the next run with ZERO manual steps.
// NWU names course sites with the module code in the title ("EDCC125", "ENGV121-2026",
// "ALDE122 Distance 2026"), so a code match is reliable — with guards:
//   • never touches an efundi_site_map row that already exists (active OR deliberately
//     deactivated — an active=false row means "leave this site alone", not "remap it");
//   • one site per module: if a module already has ANY mapping, or if 2+ unmapped sites match
//     the same module in one run (e.g. a PAL/tutorial site also carries the code), it maps
//     nothing for that module and logs the candidates for a manual pick;
//   • matches the code as a whole word, tolerating an optional space ("MATH121" / "MATH 121").
// Mutates `siteMap` in place so the newly-mapped site syncs in THIS run.
export async function autoMapSites(sb, owner, sites, siteMap) {
  const [{ data: mods, error: mErr }, { data: allRows, error: rErr }] = await Promise.all([
    sb.from('modules').select('id, code').eq('owner', owner),
    sb.from('efundi_site_map').select('efundi_site_id, module_id'),   // ALL rows, incl. inactive
  ]);
  if (mErr || rErr) { console.warn(`  auto-map: load failed: ${(mErr ?? rErr).message}`); return; }

  const knownSites = new Set((allRows ?? []).map(r => r.efundi_site_id));
  const mappedModules = new Set((allRows ?? []).map(r => r.module_id).filter(Boolean));

  // module -> unmapped sites whose title carries its code
  for (const m of mods ?? []) {
    if (mappedModules.has(m.id)) continue;
    const re = new RegExp(`\\b${m.code.replace(/(\d)/, ' ?$1')}\\b`, 'i');   // "MATH ?121"
    const hits = sites.filter(s => !knownSites.has(s.id) && re.test(s.title ?? ''));
    if (!hits.length) continue;
    if (hits.length > 1) {
      console.warn(`  auto-map: ${m.code} matches ${hits.length} sites — map one manually:`);
      for (const s of hits) console.warn(`      ${s.title} [${s.id}]`);
      continue;
    }
    const site = hits[0];
    const { error } = await sb.from('efundi_site_map').insert({
      owner, efundi_site_id: site.id, module_id: m.id, title_snapshot: site.title,
    });
    if (error) { console.warn(`  auto-map: ${m.code} insert failed: ${error.message}`); continue; }
    siteMap.set(site.id, m.id);
    console.log(`  ✚ auto-mapped: ${site.title} [${site.id}] → ${m.code}`);
  }
}

export async function existingHashes(sb, table) {
  const { data, error } = await sb.from(table).select('source_id, source_hash').eq('source', 'efundi');
  if (error) throw error;
  const m = new Map();
  for (const r of data ?? []) m.set(r.source_id, r.source_hash);
  return m;
}

export async function syncAnnouncements(sb, owner, moduleId, items, prev, counters, now) {
  for (const it of items) {
    if (!it.sourceId) continue;
    const h = hash({ t: it.title, b: it.bodyHtml, p: it.postedAt });
    const before = prev.get(it.sourceId);
    if (before === h) continue;
    const { error } = await sb.from('announcements').upsert({
      owner, module_id: moduleId, title: it.title, body_html: it.bodyHtml, posted_at: it.postedAt,
      source: 'efundi', source_id: it.sourceId, source_hash: h, source_synced_at: now,
    }, { onConflict: 'source,source_id' });
    if (error) throw error;
    before === undefined ? counters.new++ : counters.updated++;
    prev.set(it.sourceId, h);
  }
}

export async function syncAssignments(sb, owner, moduleId, items, prev, counters, now) {
  for (const it of items) {
    if (!it.sourceId) continue;
    const h = hash({ t: it.title, d: it.dueDate });
    const before = prev.get(it.sourceId);
    if (before === h) continue;
    if (before === undefined) {
      const { error } = await sb.from('assessments').insert({
        owner, module_id: moduleId, title: it.title, type: 'assignment',
        due_date: it.dueDate, status: 'upcoming',
        source: 'efundi', source_id: it.sourceId, source_hash: h, source_synced_at: now,
      });
      if (error) throw error;
      counters.new++;
    } else {
      // Update only worker-owned fields — never clobber a status/mark Megan set by hand.
      const { error } = await sb.from('assessments').update({
        title: it.title, due_date: it.dueDate, source_hash: h, source_synced_at: now,
      }).eq('source', 'efundi').eq('source_id', it.sourceId);
      if (error) throw error;
      counters.updated++;
    }
    prev.set(it.sourceId, h);
  }
}

// Supabase Storage rejects files over its per-file limit (~50MB). Skip anything near it —
// giant files (recorded lectures, huge scans) don't belong mirrored in the hub anyway.
const MAX_FILE_BYTES = 45 * 1024 * 1024;

export async function syncContent(sb, client, owner, moduleId, items, prev, counters, now) {
  for (const it of items) {
    if (!it.sourceId || !it.url) continue;
    const h = hash({ n: it.title, s: it.size, m: it.lastModified });
    const before = prev.get(it.sourceId);
    if (before === h) continue;
    if (it.size && it.size > MAX_FILE_BYTES) {
      console.warn(`    skip large file (${(it.size / 1048576).toFixed(1)}MB): ${it.title}`);
      continue;
    }

    // Everything for one file is isolated: a failed download/upload skips that file only.
    try {
      const res = await client.get(it.url, { responseType: 'buffer', timeout: { request: 120000 } });
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
      const buf = res.body;
      if (buf.length > MAX_FILE_BYTES) {
        console.warn(`    skip large file (${(buf.length / 1048576).toFixed(1)}MB): ${it.title}`);
        continue;
      }

      const path = `efundi/${moduleId}/${storageKey(it.sourceId, it.title)}`;
      const up = await sb.storage.from('resources').upload(path, buf, {
        upsert: true, contentType: it.mime || 'application/octet-stream',
      });
      if (up.error) throw up.error;

      const kind = (it.mime || '').includes('pdf') ? 'course_pdf' : 'other';
      const { error } = await sb.from('resources').upsert({
        owner, module_id: moduleId, kind, title: it.title, storage_path: path,
        size_bytes: it.size ?? buf.length,
        source: 'efundi', source_id: it.sourceId, source_hash: h, source_synced_at: now,
      }, { onConflict: 'source,source_id' });
      if (error) throw error;
      before === undefined ? counters.new++ : counters.updated++;
      prev.set(it.sourceId, h);
    } catch (e) {
      console.warn(`    file failed (${it.title}): ${e.message}`);
    }
  }
}

// Storage object keys must be ASCII-safe (Supabase rejects some non-ASCII). sourceId prefix
// keeps it unique per file.
function storageKey(sourceId, title) {
  return `${sourceId}-${title}`
    .normalize('NFKD').replace(/[^\x20-\x7E]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 180);
}
