// The tick-off ping (s23 — Megan's ask: "a satisfying, dopamine releasing ping when we tick off
// things"). Her own 0,7 s mp3, played on the three ticks that mean something got DONE:
// the To Do List, My Week's deadline ✓, and a module's Assessments ✓.
//
// Web Audio rather than `new Audio()`, for two reasons that both show up in real use:
//   1. an <audio> element only starts decoding when you press play, so the FIRST ping lands late —
//      exactly the tap where the reward is supposed to be instant;
//   2. one element cannot overlap itself, so ticking two things quickly cuts the first ping off
//      mid-ring. Here the file is fetched and decoded ONCE and each tick starts a fresh source
//      node off the same buffer: instant every time, and happily overlapping.
//
// ⚠ The hub lives at megzieberr.github.io/nwu-hub/, so the URL MUST go through Vite's BASE_URL.
// A bare '/ping.mp3' works on the dev server and 404s on live — the classic way to ship a silent
// sound and only find out on the phone.

const SRC = `${import.meta.env.BASE_URL}ping.mp3`
const MUTE_KEY = 'nwu-hub-ping-muted'

let ctx = null
let buffer = null
let decoding = null

// Per DEVICE, not per account: the answer to "do I want sound right now" belongs to where you
// are (lecture hall vs kitchen table), not to who you are. localStorage is wrapped because it
// throws outright in a locked-down browser, and a mute preference must never break the tick.
export function pingMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}

export function setPingMuted(muted) {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0') } catch { /* not worth surfacing */ }
}

// Fetched at import time — no audio permission is needed to download bytes, only to play them.
// That way the decode on the first tick has the file already in hand. 30 KB, and the service
// worker keeps it cached after the first visit anyway.
let bytes = fetch(SRC).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)

// Created lazily, INSIDE the click handler, on purpose: browsers refuse to start an AudioContext
// before the user has interacted with the page, and iOS leaves one created too early stuck in
// 'suspended' for the rest of the session. A tick is the interaction, so this always succeeds.
function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

function decoded(c) {
  if (buffer) return Promise.resolve(buffer)
  if (!decoding) {
    // slice() because decodeAudioData DETACHES the ArrayBuffer it is handed — keeping the
    // original intact means a failed decode can be retried instead of failing for ever.
    decoding = bytes
      .then((b) => (b ? c.decodeAudioData(b.slice(0)) : null))
      .then((d) => { buffer = d; return d })
      .catch(() => { decoding = null; return null })
  }
  return decoding
}

// Fire and forget. EVERY failure path is swallowed on purpose: the sound is a nicety, and no
// browser quirk, blocked context or missing file may stop a to-do from being ticked off.
export function ping() {
  if (pingMuted()) return
  try {
    const c = audioCtx()
    if (!c) return
    decoded(c).then((buf) => {
      if (!buf) return
      const src = c.createBufferSource()
      src.buffer = buf
      const gain = c.createGain()
      gain.gain.value = 0.7
      src.connect(gain).connect(c.destination)
      src.start()
    })
  } catch { /* never let the ping break the tick */ }
}
