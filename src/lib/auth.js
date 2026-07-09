import { supabase } from './supabase'

// Synthetic-email username auth (Megan's standard): a username maps to a fake email,
// so there's no inbox involved. Requires "Confirm email" OFF in Supabase Auth settings.
const DOMAIN = 'nwu-hub.local'
export const usernameToEmail = (u) => `${u.trim().toLowerCase()}@${DOMAIN}`

// Log in; if the account doesn't exist yet (first ever run), create it.
export async function signInOrUp(username, password) {
  const email = usernameToEmail(username)

  const login = await supabase.auth.signInWithPassword({ email, password })
  if (!login.error) return { session: login.data.session, created: false }

  // Supabase returns a generic "Invalid login credentials" for both a wrong password
  // and a missing account. On first run the account doesn't exist, so try to create it.
  const signup = await supabase.auth.signUp({ email, password })
  if (signup.error) {
    // Account already existed -> the original error was really a wrong password.
    if (/already registered/i.test(signup.error.message)) {
      throw new Error('Wrong password for that username.')
    }
    throw signup.error
  }
  return { session: signup.data.session, created: true }
}

export async function signOut() {
  await supabase.auth.signOut()
}
