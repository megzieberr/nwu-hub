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

// nameKey — normalize a resource title for duplicate detection: collapse every '+'/whitespace
// run to a single space, trim, lowercase. This is the ONE definition; the fetch-side dedupe
// (index.js), the DB-only dedupe seed (index.js), and purgeDuplicateResources below all import
// it, so they can never drift out of lockstep (a past bug: two dedupers with different worlds
// oscillated forever). "MATV 121 Tutorial Task 2.pdf" and "MATV+121+Tutorial+Task+2.pdf" both
// normalize to "matv 121 tutorial task 2.pdf".
export function nameKey(title) {
  return String(title).replace(/[+\s]+/g, ' ').trim().toLowerCase();
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

// Lecturers sometimes upload/link the same document twice under cosmetically different names
// ("MATV 121 Tutorial Task 2.pdf" vs "MATV+121+Tutorial+Task+2.pdf"). index.js dedupes new
// fetches, but rows that already slipped in (or arrive via a path we don't dedupe) linger —
// so, like purgeVideos, enforce the invariant each run: within one module, efundi resources
// whose normalized titles match are duplicates; keep the cleanest title, remove the rest.
// Normalization MUST match index.js's nameKey: collapse '+'/whitespace runs, lowercase.
export async function purgeDuplicateResources(sb) {
  const { data, error } = await sb.from('resources')
    .select('id, module_id, title, storage_path').eq('source', 'efundi');
  if (error) { console.warn(`purgeDuplicateResources: ${error.message}`); return 0; }
  const plusCount = t => (String(t).match(/\+/g) || []).length;
  const groups = new Map();
  for (const r of data ?? []) {
    const key = `${r.module_id}|${nameKey(r.title)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
  }
  const losers = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => plusCount(a.title) - plusCount(b.title) || String(a.title).localeCompare(b.title));
    losers.push(...rows.slice(1));
  }
  if (!losers.length) return 0;
  const paths = losers.map(r => r.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: se } = await sb.storage.from('resources').remove(paths);
    if (se) console.warn(`purgeDuplicateResources storage remove: ${se.message}`);
  }
  const { error: de } = await sb.from('resources').delete().in('id', losers.map(r => r.id));
  if (de) { console.warn(`purgeDuplicateResources row delete: ${de.message}`); return 0; }
  for (const r of losers) console.log(`  purged duplicate resource: ${r.title}`);
  return losers.length;
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

// loadSiteTitles — title_snapshot for every ACTIVE mapped site, used purely to label sites
// that site.json omits (see index.js fallback) with something friendlier than a bare uuid.
export async function loadSiteTitles(sb) {
  const { data, error } = await sb.from('efundi_site_map')
    .select('efundi_site_id, title_snapshot').eq('active', true);
  if (error) throw error;
  return new Map((data ?? []).map(r => [r.efundi_site_id, r.title_snapshot]));
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

// loadModuleResourceRows — (source_id, title) of one module's synced eFundi resources, for the
// DB-only dedupe seed in index.js. Module-scoped on purpose (single per-site query, not a
// second full-table scan). A load failure is non-fatal: the seed is empty, so the fetch-side
// dedupe just behaves as it did before this fix (churn), never worse.
export async function loadModuleResourceRows(sb, moduleId) {
  const { data, error } = await sb.from('resources')
    .select('source_id, title').eq('source', 'efundi').eq('module_id', moduleId);
  if (error) { console.warn(`loadModuleResourceRows: ${error.message}`); return []; }
  return data ?? [];
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

// findAdoptableAssessment — a hand-seeded assessment in this module that IS the eFundi item we
// are about to insert. Assessments are seeded by hand from the study guide long before the
// lecturer opens the matching eFundi assignment, so a source_id-only dedupe (the old behaviour)
// twinned them: ENGV121 ended up with both "Assignment 1 · Sociolinguistics (pair)" (curated:
// weight, brief attached) and a bare "Assignment 1" from the sync. Same shape as the s10b
// resource fix — look at the DB, not just this fetch.
//
// Matched on nameKey PREFIX, because the curated title is the eFundi one plus a descriptive
// suffix ("Assignment 1" -> "Assignment 1 · Sociolinguistics (pair)"). Prefix, not substring, so
// "Assignment 1" can never adopt "Assignment 10". Only rows with source IS NULL are eligible, so
// this can never steal a row already owned by another eFundi item.
// Pure decision, exported so sync/verify-assessment-adopt.mjs tests the code that actually runs.
// True when `localTitle` is the same assessment as eFundi's `efundiTitle`: either identical, or
// eFundi's title plus a descriptive suffix. The separator check is what stops "Assignment 1"
// from swallowing "Assignment 10".
export function isSameAssessment(localTitle, efundiTitle) {
  const key = nameKey(efundiTitle);
  const k = nameKey(localTitle);
  if (!key || !k) return false;
  if (k === key) return true;
  if (!k.startsWith(key)) return false;
  return /^[\s·:\-–—(,.]/.test(k.slice(key.length));
}

async function findAdoptableAssessment(sb, moduleId, title) {
  const { data, error } = await sb.from('assessments')
    .select('id, title').eq('module_id', moduleId).is('source', null);
  if (error) { console.warn(`findAdoptableAssessment: ${error.message}`); return null; }
  return (data ?? []).find((r) => isSameAssessment(r.title, title)) ?? null;
}

export async function syncAssignments(sb, owner, moduleId, items, prev, counters, now) {
  for (const it of items) {
    if (!it.sourceId) continue;
    const h = hash({ t: it.title, d: it.dueDate });
    const before = prev.get(it.sourceId);
    if (before === h) continue;
    if (before === undefined) {
      const adopt = await findAdoptableAssessment(sb, moduleId, it.title);
      if (adopt) {
        // Take ownership of the curated row instead of inserting a twin. Its title is left
        // alone — the hand-written one is more informative than eFundi's, and weight/status/
        // mark and any attached brief stay put. From now on it updates in place below.
        const { error } = await sb.from('assessments').update({
          due_date: it.dueDate,
          source: 'efundi', source_id: it.sourceId, source_hash: h, source_synced_at: now,
        }).eq('id', adopt.id);
        if (error) throw error;
        console.log(`  = adopted existing assessment "${adopt.title}" for eFundi "${it.title}"`);
        counters.updated++;
      } else {
        const { error } = await sb.from('assessments').insert({
          owner, module_id: moduleId, title: it.title, type: 'assignment',
          due_date: it.dueDate, status: 'upcoming',
          source: 'efundi', source_id: it.sourceId, source_hash: h, source_synced_at: now,
        });
        if (error) throw error;
        counters.new++;
      }
    } else {
      // Update only worker-owned fields — never clobber a status/mark Megan set by hand.
      // due_date is always worker-owned: eFundi is the authority on dates once a row is linked,
      // which is the whole point of the link. The title is only overwritten when it still looks
      // like eFundi's own — a title that EXTENDS the eFundi one is hand-curated (an adopted row,
      // or one she renamed), and a lecturer's rename must not eat that description.
      const { data: cur } = await sb.from('assessments')
        .select('title').eq('source', 'efundi').eq('source_id', it.sourceId).maybeSingle();
      const curated = !!cur && nameKey(cur.title) !== nameKey(it.title)
        && isSameAssessment(cur.title, it.title);
      const patch = { due_date: it.dueDate, source_hash: h, source_synced_at: now };
      if (!curated) patch.title = it.title;
      const { error } = await sb.from('assessments').update(patch)
        .eq('source', 'efundi').eq('source_id', it.sourceId);
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
      if (error) {
        // 23505 on resources_storage_path_key = two eFundi sourceIds sanitised to one storage
        // key (a residual duplicate the fetch-side dedupe should already have caught). Last-resort
        // dedupe, not a run failure: the document is in the hub under the other row. Warn, skip,
        // don't count — so it never reads as an error in the logs.
        if (error.code === '23505') {
          console.warn(`    · already in hub (dedupe caught a residual duplicate), skipped: ${it.title}`);
          continue;
        }
        throw error;
      }
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
