// Push notifications — client side (NWU Study Hub).
//
// Asks Megan for permission, subscribes THIS device to web-push, and stores the subscription in
// public.push_subscriptions via her authenticated Supabase session. Because the hub uses real
// Supabase auth (not name+password like Circle Quest), the row goes in DIRECTLY under owner-RLS —
// no SECURITY DEFINER RPC. The service worker (public/sw.js) shows the notification when it arrives.
//
// iPhone note: PushManager only exists once the app has been ADDED TO THE HOME SCREEN and opened
// from that icon — so pushSupported() is naturally false in a plain Safari tab and the UI hides.
import { supabase } from './supabase'
import { VAPID_PUBLIC_KEY } from './push-config'

export function pushSupported() {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function pushConfigured() {
  return !!VAPID_PUBLIC_KEY
}

// Running as an installed PWA (vs a browser tab)? Web push on iOS needs this to be true.
export function isStandalone() {
  return (
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true // iOS Safari flag
  )
}

// VAPID public keys are base64url text; the browser's subscribe() needs raw bytes.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// Current state: 'unsupported' | 'unconfigured' | 'blocked' | 'on' | 'off'
export async function pushState() {
  if (!pushSupported()) return 'unsupported'
  if (!pushConfigured()) return 'unconfigured'
  if (Notification.permission === 'denied') return 'blocked'
  if (Notification.permission !== 'granted') return 'off'
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    return sub ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

// Ask permission, subscribe this device, save it. Returns { ok:true } or { ok:false, reason }.
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }
  if (!pushConfigured()) return { ok: false, reason: 'unconfigured' }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: permission } // 'denied' | 'default'

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }

  const json = sub.toJSON()
  // owner defaults to auth.uid() server-side; upsert on endpoint so re-enabling one device is idempotent.
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({ endpoint: sub.endpoint, subscription: json }, { onConflict: 'endpoint' })
  if (error) return { ok: false, reason: error.message }
  return { ok: true }
}

// Turn reminders off for this device (unsubscribe + forget the row).
export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      const endpoint = sub.endpoint
      await sub.unsubscribe()
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'error' }
  }
}
