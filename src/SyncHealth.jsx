import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { syncHealthView } from './lib/synchealth'

// The amber the hub already warns in (App.jsx syncStatusColour / SyncAlert).
const AMBER = '#f0b232'

// The header's sync-health line — "is eFundi still coming in?"
//
// GitHub's scheduler dropped the sync for six days and nothing said so (PLAN-sync-trigger.md §1).
// Push was the obvious alarm and is ruled out: Megan's phone refuses notifications. But she opens
// this hub many times a day, so the hub is the alarm. Quiet grey line when all is well; an amber
// pill the moment the newest SUCCESSFUL run is over 14 hours old.
//
// Data comes from the sync_health() RPC (supabase/migrations/0019_sync_health.sql), not from
// efundi_sync_runs directly: the function is security-definer and hands back three values, so the
// run log itself (owner ids, error text) stays shut. It is granted to `authenticated` only.
//
// The decision and the wording live in lib/synchealth.js so they can be tested on Node
// (sync/verify-synchealth.mjs). This file only fetches and paints.
export default function SyncHealth() {
  const [lastOk, setLastOk] = useState(undefined)   // undefined = not answered yet, null = never synced

  useEffect(() => {
    let cancelled = false

    async function load() {
      const { data, error } = await supabase.rpc('sync_health')
      if (cancelled) return
      // No session yet, RPC missing, or any other failure: stay invisible. A broken pill would be
      // one more thing to wonder about, and this line's whole job is to be trustworthy.
      if (error) { setLastOk(undefined); return }
      // A `returns table` function comes back as an array of rows through PostgREST; take the row
      // either way, since a single-row shape is not worth depending on.
      const row = Array.isArray(data) ? data[0] : data
      if (!row) { setLastOk(undefined); return }
      setLastOk(row.last_ok ?? null)
    }

    load()

    // She leaves the PWA open on her phone and comes back to it, so a resumed tab must re-ask
    // rather than show whatever was true when it was last opened.
    function onVisible() {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  if (lastOk === undefined) return null

  const { state, label } = syncHealthView(lastOk)

  // Both states carry their own bottom margin: the header slot has no padding, so that a hidden
  // line (failed RPC) collapses to nothing instead of leaving a gap.
  const spacing = { marginBottom: 14 }

  // All clear: small, grey, and easy to ignore. It is a receipt, not news.
  if (state === 'ok') {
    return <div className="muted text-xs" style={{ ...spacing, letterSpacing: '.4px' }}>{label}</div>
  }

  // Stale or never: the amber pill, in the same warning amber the sync banner already uses.
  // Sized to sit in a header without becoming a headline, but bordered and glowing enough that
  // it cannot be mistaken for the grey line it replaces.
  return (
    <div
      role="status"
      style={{
        ...spacing,
        display: 'inline-flex', alignItems: 'center', gap: 7, maxWidth: '100%',
        padding: '4px 11px', borderRadius: 999,
        border: `1px solid ${AMBER}`, color: AMBER,
        background: 'rgba(240, 178, 50, 0.10)',
        boxShadow: '0 0 14px rgba(240, 178, 50, 0.25)',
        fontSize: 13, fontWeight: 600, lineHeight: 1.35,
      }}
    >
      <span aria-hidden="true" style={{ flex: '0 0 auto' }}>⚠️</span>
      <span style={{ minWidth: 0 }}>{label}</span>
    </div>
  )
}
