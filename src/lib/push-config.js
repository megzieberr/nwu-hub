// The VAPID PUBLIC key for web-push. Public keys are safe to commit (they only let the browser
// verify a notification really came from this app); the matching PRIVATE key lives ONLY as a
// Supabase Edge secret. Paste the public key from `python tools/gen_vapid.py` between the quotes.
//
// While this is empty the Reminders card stays hidden — so shipping this file early is harmless.
// See PUSH-SETUP.md.
export const VAPID_PUBLIC_KEY = 'BDE9oNkqLz3UbVC-6zCJcSaMUkwwNBHJ9Ajblbn1AESWK2hkz-F4YV8kgtWQUf-ZsiuJ0jVsjIxris0a21cjf7k'
