// auth.js — replay NWU's classic Apereo/Jasig CAS login form and return an
// authenticated `got` client (cookie jar holds JSESSIONID + the haproxy sticky cookie).
//
// Flow confirmed in Phase 0 recon (docs/efundi-sync-recon.md):
//   GET  https://casprd.nwu.ac.za/cas/login?service=<efundi container>
//        -> scrape hidden tokens (execution, lt, _eventId) fresh every run
//   POST username + password + those tokens back to the form action
//        -> CAS 302s to the service with ?ticket=ST-..., Sakai sets JSESSIONID
//   GET  /direct/session.json to confirm we really have a session.
//
// On ANY failure (still on login page, or a Microsoft/MFA redirect) we throw AuthError
// and the run STOPS — never retry a bad password (account-lockout risk).

import got from 'got';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

const SERVICE_URL = 'https://efundi.nwu.ac.za/sakai-login-tool/container';
const CAS_LOGIN   = 'https://casprd.nwu.ac.za/cas/login';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NWU-Study-Hub-Sync/1.0 (personal study automation)';

export async function login({ username, password }) {
  if (!username || !password) throw new AuthError('Missing eFundi username or password (check Actions Secrets).');

  const cookieJar = new CookieJar();
  const client = got.extend({
    cookieJar,
    timeout: { request: 30000 },
    headers: { 'user-agent': UA },
    retry: { limit: 0 },        // never hammer CAS
    followRedirect: true,
    throwHttpErrors: false,
  });

  const loginUrl = `${CAS_LOGIN}?service=${encodeURIComponent(SERVICE_URL)}`;

  // 1. GET the login form and scrape it
  const page = await client.get(loginUrl);
  const $ = cheerio.load(page.body);
  const forms = $('form').toArray();
  const formEl = forms.find(f => $(f).find('input[name="username"], input[name="password"]').length) || forms[0];
  if (!formEl) throw new AuthError('CAS login form not found — page layout may have changed.');
  const $form = $(formEl);

  // collect every input (keeps execution / lt / _eventId fresh — never hardcode these)
  const fields = {};
  $form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    if (name) fields[name] = $(el).attr('value') ?? '';
  });
  fields.username = username;
  fields.password = password;
  if (!('_eventId' in fields)) fields._eventId = 'submit';
  delete fields.warn;   // leave the "warn before SSO" box unchecked

  const action = $form.attr('action') || page.url;
  const postUrl = new URL(action, page.url).toString();

  // 2. POST credentials; got follows the 302 -> service?ticket -> Sakai chain,
  //    collecting JSESSIONID + haproxy cookies into the jar.
  await client.post(postUrl, {
    form: fields,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  // 3. Prove we are authenticated
  const check = await client.get('https://efundi.nwu.ac.za/direct/session.json');
  if ((check.url || '').includes('login.microsoftonline.com'))
    throw new AuthError('Unexpected Microsoft 365 / MFA redirect — headless login is not viable (see plan Plan B).');

  let userEid = null;
  try { userEid = JSON.parse(check.body)?.session_collection?.[0]?.userId ?? null; } catch { /* not JSON */ }
  if (!userEid)
    throw new AuthError('Login did not establish a Sakai session — wrong credentials, or still on the login page.');

  return { client, cookieJar, userEid };
}
