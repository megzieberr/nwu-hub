import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'

// Feed host — same Supabase project as VITE_SUPABASE_URL in .env.local / the GitHub Pages build
// env (src/lib/supabase.js). Hardcoded here (with this comment) rather than reaching into the
// supabase-js client for its internal url, which isn't part of its public API. If the project
// ever moves, update this alongside VITE_SUPABASE_URL.
const FEED_HOST = 'https://aefjicdxeflqnquiebvc.supabase.co'

// 📆 Classes in my calendar — owner-only opt-in card (PLAN-calendar-feed.md §3), same visual
// family as RemindersCard below it on the dashboard. Renders nothing until the my_ics_token() RPC
// resolves, and stays hidden entirely for a viewer (the RPC returns null for anyone but the
// token's own owner — profiles.ics_token itself is locked out of every normal grant, see
// supabase/migrations/0016_ics_token.sql, so this card never selects that column directly).
export default function CalendarCard() {
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    supabase.rpc('my_ics_token').then(({ data }) => {
      if (cancelled) return
      setToken(data || null)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  if (loading || !token) return null

  const feedUrl = `${FEED_HOST}/functions/v1/ics-feed?t=${token}`
  const webcalUrl = feedUrl.replace(/^https:/, 'webcal:')
  const googleUrl = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API blocked (permissions, non-HTTPS, etc.) — the other two buttons still work.
    }
  }

  return (
    <div className="panel bracket p-5">
      <div className="section-label">📆 Classes in my calendar</div>
      <div className="text-sm muted mt-1">Add every class once. New classes appear on their own, and changes follow.</div>

      <div className="panel mt-4">
        <a href={googleUrl} target="_blank" rel="noopener noreferrer" className="row" style={{ textDecoration: 'none', gap: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#eaf4ff' }}>Add in Google Calendar</div>
            <div className="muted text-sm mt-1">Best done once on a computer — it then syncs to your phone by itself.</div>
          </span>
          <span className="btn small ghost" style={{ borderColor: 'var(--cyan)', color: 'var(--cyan)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>Add →</span>
        </a>

        <a href={webcalUrl} className="row" style={{ textDecoration: 'none', gap: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#eaf4ff' }}>iPhone, iPad or Mac</div>
            <div className="muted text-sm mt-1">Opens Calendar and asks you to subscribe.</div>
          </span>
          <span className="btn small ghost" style={{ borderColor: 'var(--cyan)', color: 'var(--cyan)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>Add →</span>
        </a>

        <div className="row" style={{ gap: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#eaf4ff' }}>Copy the link instead</div>
            <div className="muted text-sm mt-1">For any other calendar app.</div>
          </span>
          <button onClick={copyLink} className="btn small ghost"
            style={{ borderColor: 'var(--line-strong)', color: 'var(--muted)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>
            {copied ? 'Link copied.' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="muted text-xs mt-4">
        Google refreshes this on its own schedule (a few hours to a day). A class posted for the same day may not show in time — use the 📅 on that class as well.
      </div>
      <div className="muted text-xs mt-1">
        Set the new calendar's notifications to 30 minutes in Google Calendar settings — that's what fires on your phone.
      </div>
    </div>
  )
}
