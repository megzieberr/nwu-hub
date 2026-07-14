// index.js — orchestrate one sync run:
//   open a efundi_sync_runs row -> auth -> fetch each mapped site -> dedupe+write -> close the row.
// An AuthError records status 'auth_failed' and exits non-zero (visible failed Actions run),
// and NEVER retries. Any other error records 'error'. The run row is always closed.

import { login, AuthError } from './auth.js';
import { listSites, fetchSiteAnnouncements, fetchSiteAssignments, fetchSiteContent, fetchSiteLessons } from './fetch-efundi.js';
import {
  makeSupabase, resolveOwner, loadSiteMap, loadSiteTitles, autoMapSites, existingHashes,
  loadModuleResourceRows, nameKey,
  syncAnnouncements, syncAssignments, syncContent, purgeVideos, purgeDuplicateResources,
} from './write.js';
import { generateObjectives } from './objectives.js';

async function main() {
  const sb = makeSupabase();
  const owner = await resolveOwner(sb);
  const now = new Date().toISOString();
  const counters = { new: 0, updated: 0 };

  const { data: run, error: runErr } = await sb
    .from('efundi_sync_runs').insert({ owner, status: 'ok' }).select('id').single();
  if (runErr) throw runErr;
  const runId = run.id;

  try {
    const { client } = await login({
      username: process.env.EFUNDI_USERNAME,
      password: process.env.EFUNDI_PASSWORD,
    });
    console.log('✓ Authenticated to eFundi.');

    await purgeVideos(sb);   // enforce "no videos in the hub" before anything else
    await purgeDuplicateResources(sb);   // and "one row per document" (double-linked files)

    const siteMap = await loadSiteMap(sb);
    if (siteMap.size === 0)
      console.warn('! No mapped sites in efundi_site_map — nothing will sync. Seed it (see sync/README.md).');

    const [prevAnn, prevAsg, prevRes] = await Promise.all([
      existingHashes(sb, 'announcements'),
      existingHashes(sb, 'assessments'),
      existingHashes(sb, 'resources'),
    ]);

    const sites = await listSites(client);
    // Map any new module site by title before syncing, so it's picked up in this same run.
    // Non-fatal: a failure here just means that site waits for a manual mapping.
    try { await autoMapSites(sb, owner, sites, siteMap); }
    catch (e) { console.warn(`  auto-map error (non-fatal): ${e?.message ?? e}`); }
    console.log(`eFundi reports ${sites.length} site(s); ${siteMap.size} mapped.`);

    // Safety net: site.json has dropped enrolled sites before (pagination default of 10
    // hid MATV121, 2026-07-12). A mapped site we KNOW about must sync even when the
    // listing omits it — the per-site /direct endpoints only need the id, and a stale or
    // wrong id is harmless (they just return empty). Non-fatal: labels fall back to uuid.
    try {
      const listed = new Set(sites.map(s => s.id));
      const titles = await loadSiteTitles(sb);
      for (const siteId of siteMap.keys()) {
        if (listed.has(siteId)) continue;
        const title = titles.get(siteId) || siteId;
        console.log(`  + mapped but missing from site.json — syncing anyway: ${title} [${siteId}]`);
        sites.push({ id: siteId, title });
      }
    } catch (e) { console.warn(`  mapped-site fallback error (non-fatal): ${e?.message ?? e}`); }

    let hadError = false;
    for (const site of sites) {
      const moduleId = siteMap.get(site.id);
      if (!moduleId) { console.log(`  · skip (unmapped): ${site.title} [${site.id}]`); continue; }
      console.log(`  → syncing: ${site.title}`);
      try {
        // Announcements + assignments are light — fetch concurrently. Content is heavy and
        // times out under eFundi's latency when it competes, so give it its own clean request.
        const [anns, asgs] = await Promise.all([
          fetchSiteAnnouncements(client, site.id),
          fetchSiteAssignments(client, site.id),
        ]);
        // Files can live in the Resources tool and/or embedded in Lessons pages — gather both,
        // dedupe by the file's sakaiId (Resources entry wins; it carries size for edit-detection).
        const [resFiles, lessonFiles] = await Promise.all([
          fetchSiteContent(client, site.id),
          fetchSiteLessons(client, site.id),
        ]);
        // Lecturers sometimes link the SAME document twice under cosmetically different names
        // (MATV121 has "MATV 121 Tutorial Task 7.pdf" AND a "MATV+121+…" upload artifact —
        // distinct sakaiIds, identical content). Dedupe by normalized filename too, preferring
        // the cleaner title (fewest '+'); the sort is stable, so Resources still wins ties.
        // Prefer, in order: the variant already in the hub (else purgeDuplicateResources and
        // this dedupe can each pick a DIFFERENT winner and the pair oscillates forever —
        // purge deletes one at run start, this re-inserts the other as "new", every run),
        // then the cleanest title (fewest '+'); the sort is stable, so Resources wins ties.
        const plusCount = t => (String(t).match(/\+/g) || []).length;
        const byId = new Map();
        const byName = new Set();
        const candidates = [...resFiles, ...lessonFiles].sort((a, b) =>
          (prevRes.has(a.sourceId) ? 0 : 1) - (prevRes.has(b.sourceId) ? 0 : 1)
          || plusCount(a.title) - plusCount(b.title));
        // The clean twin of a '+'-artifact can live ONLY in the DB now: when a lecturer
        // restructures a site, the old file path stops being served and eFundi offers just the
        // '+' upload variant under a NEW sourceId. The dedupe below sees only this fetch, so it
        // can't tell that variant is a duplicate of an already-synced document — it would insert
        // it as "new" every run, then purgeDuplicateResources deletes it again next run (churn),
        // or it collides on storage_path (hard fail). So seed byName with the nameKeys of THIS
        // module's synced rows whose sourceId is no longer in the fetch: a served variant of one
        // of those is then skipped as a duplicate. A row still served under its own sourceId is
        // NOT seeded (its id IS in the fetch), so real hash-change updates still flow.
        const fetchedIds = new Set(candidates.map(c => c.sourceId).filter(Boolean));
        const dbOnlyNames = new Set(
          (await loadModuleResourceRows(sb, moduleId))
            .filter(r => !fetchedIds.has(r.source_id))
            .map(r => nameKey(r.title))
        );
        for (const f of candidates) {
          if (!f.sourceId || byId.has(f.sourceId)) continue;
          const key = nameKey(f.title);
          if (dbOnlyNames.has(key)) { console.log(`    · duplicate of a synced document, skipped: ${f.title}`); continue; }
          if (byName.has(key)) { console.log(`    · same document linked twice on eFundi, skipped: ${f.title}`); continue; }
          byId.set(f.sourceId, f);
          byName.add(key);
        }
        const files = [...byId.values()];
        if (lessonFiles.length) console.log(`    (${lessonFiles.length} file(s) from Lessons; ${resFiles.length} from Resources)`);
        await syncAnnouncements(sb, owner, moduleId, anns, prevAnn, counters, now);
        await syncAssignments(sb, owner, moduleId, asgs, prevAsg, counters, now);
        await syncContent(sb, client, owner, moduleId, files, prevRes, counters, now);
      } catch (e) {
        // One bad site shouldn't sink the run — log it, mark partial, keep going.
        hadError = true;
        console.error(`    ! ${site.title} failed: ${e?.message ?? e}`);
      }
    }

    // Processing layer: turn the announcements we just stored into study objectives.
    // Non-fatal — a failure here never fails the sync (the raw data is already saved).
    try { await generateObjectives(sb); }
    catch (e) { console.warn(`  objectives agent error (non-fatal): ${e?.message ?? e}`); }

    await sb.from('efundi_sync_runs').update({
      finished_at: new Date().toISOString(), status: hadError ? 'partial' : 'ok',
      items_new: counters.new, items_updated: counters.updated,
    }).eq('id', runId);
    console.log(`✓ Done. New: ${counters.new}, Updated: ${counters.updated}.`);
  } catch (err) {
    const status = err instanceof AuthError ? 'auth_failed' : 'error';
    await sb.from('efundi_sync_runs').update({
      finished_at: new Date().toISOString(), status,
      items_new: counters.new, items_updated: counters.updated,
      error: String(err?.message ?? err).slice(0, 2000),
    }).eq('id', runId);
    console.error(`✗ ${status}: ${err?.message ?? err}`);
    process.exitCode = 1;   // fail the Actions run so it's visible; do NOT retry
  }
}

main().catch(e => { console.error(e); process.exit(1); });
