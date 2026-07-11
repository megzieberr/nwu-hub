// index.js — orchestrate one sync run:
//   open a efundi_sync_runs row -> auth -> fetch each mapped site -> dedupe+write -> close the row.
// An AuthError records status 'auth_failed' and exits non-zero (visible failed Actions run),
// and NEVER retries. Any other error records 'error'. The run row is always closed.

import { login, AuthError } from './auth.js';
import { listSites, fetchSiteAnnouncements, fetchSiteAssignments, fetchSiteContent } from './fetch-efundi.js';
import {
  makeSupabase, resolveOwner, loadSiteMap, existingHashes,
  syncAnnouncements, syncAssignments, syncContent,
} from './write.js';

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

    const siteMap = await loadSiteMap(sb);
    if (siteMap.size === 0)
      console.warn('! No mapped sites in efundi_site_map — nothing will sync. Seed it (see sync/README.md).');

    const [prevAnn, prevAsg, prevRes] = await Promise.all([
      existingHashes(sb, 'announcements'),
      existingHashes(sb, 'assessments'),
      existingHashes(sb, 'resources'),
    ]);

    const sites = await listSites(client);
    console.log(`eFundi reports ${sites.length} site(s); ${siteMap.size} mapped.`);

    for (const site of sites) {
      const moduleId = siteMap.get(site.id);
      if (!moduleId) { console.log(`  · skip (unmapped): ${site.title} [${site.id}]`); continue; }
      console.log(`  → syncing: ${site.title}`);

      const [anns, asgs, files] = await Promise.all([
        fetchSiteAnnouncements(client, site.id),
        fetchSiteAssignments(client, site.id),
        fetchSiteContent(client, site.id),
      ]);
      await syncAnnouncements(sb, owner, moduleId, anns, prevAnn, counters, now);
      await syncAssignments(sb, owner, moduleId, asgs, prevAsg, counters, now);
      await syncContent(sb, client, owner, moduleId, files, prevRes, counters, now);
    }

    await sb.from('efundi_sync_runs').update({
      finished_at: new Date().toISOString(), status: 'ok',
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
