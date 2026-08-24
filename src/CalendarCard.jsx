import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'

// Feed host — same Supabase project as VITE_SUPABASE_URL in .env.local / the GitHub Pages build
// env (src/lib/supabase.js). Hardcoded here (with this comment) rather than reaching into the
// supabase-js client for its internal url, which isn't part of its public API. If the project
// ever moves, update this alongside VITE_SUPABASE_URL.
const FEED_HOST = 'https://aefjicdxeflqnquiebvc.supabase.co'

// 📅 Classes in my calendar — owner-only opt-in (PLAN-calendar-feed.md §3).
//
// s22: this was a full dashboard card. Megan's ask — "can we make this massive google calendar tab
// a smaller calendar icon at the top" — is right: subscribing is a ONCE job (done 2026-08-22), so
// the instructions were eating a screen's worth of dashboard forever after. Now a header icon that
// opens the same three options on demand, same shape as the 🎫 Tests & Exams button/overlay.
//
// Renders nothing until the my_ics_token() RPC resolves, and stays hidden entirely for a viewer
// (the RPC returns null for anyone but the token's own owner — profiles.ics_token itself is locked
// out of every normal grant, see supabase/migrations/0016_ics_token.sql, so this never selects
// that column directly).
export default function CalendarFeedButton() {
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

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

  return (
    <>
      <button onClick={() => setOpen(true)} className="icon-btn"
        aria-label="Classes in my calendar" title="Classes in my calendar">📅</button>
      {open && <CalendarFeedOverlay token={token} onClose={() => setOpen(false)} />}
    </>
  )
}

function CalendarFeedOverlay({ token, onClose }) {
  const [copied, setCopied] = useState(false)

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
    <div className="overlay p-3 sm:p-6" style={{ flexDirection: 'column' }} onClick={onClose}>
      <div className="panel w-full max-w-xl flex flex-col overflow-hidden"
        style={{ padding: 0, maxHeight: '92vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <span className="section-label" style={{ color: 'var(--cyan)' }}>📅 Classes in my calendar</span>
          <button onClick={onClose} className="icon-btn">✕</button>
        </div>

        <div className="overflow-y-auto px-4 py-4">
          <div className="text-sm muted">Add every class once. New classes appear on their own, and changes follow.</div>

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
      </div>
    </div>
  )
}
