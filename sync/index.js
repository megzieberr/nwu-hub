// index.js — orchestrate one sync run:
//   open a efundi_sync_runs row -> auth -> fetch each mapped site -> dedupe+write -> close the row.
// An AuthError records status 'auth_failed' and exits non-zero (visible failed Actions run),
// and NEVER retries. Any other error records 'error'. The run row is always closed.

import { login, AuthError } from './auth.js';
import { listSites, fetchSiteAnnouncements, fetchSiteAssignments, fetchSiteContent, fetchSiteLessons } from './fetch-efundi.js';
import {
  makeSupabase, resolveOwner, loadSiteMap, autoMapSites, existingHashes,
  syncAnnouncements, syncAssignments, syncContent, purgeVideos,
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
        const byId = new Map();
        for (const f of [...resFiles, ...lessonFiles]) if (f.sourceId && !byId.has(f.sourceId)) byId.set(f.sourceId, f);
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
