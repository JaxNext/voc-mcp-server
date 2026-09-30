// Worker-side consent screen (tech-design §3): the user consents twice — once
// to the MCP client here, once to Voc on Supabase. The copy must explain what
// is being granted, because Voc's own consent page renders no scope list
// (§7.5).
//
// CSRF: double-submit cookie. The page sets `__Host-CSRF_TOKEN` (the __Host-
// prefix forces Secure + Path=/ + no Domain) and embeds the same value in the
// form; the POST handler acts only when they match. On top of that, the OAuth
// provider binds its consent handle to the browser with its own cookie, so a
// stolen handle alone is useless.
//
// Everything client-controlled (client_name, logo_uri, scopes) is escaped; the
// logo only renders over https so it cannot become a tracking pixel.

export const CSRF_COOKIE = '__Host-CSRF_TOKEN'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function isSafeLogoUri(uri: string | undefined): uri is string {
  if (!uri) return false
  try {
    return new URL(uri).protocol === 'https:'
  } catch {
    return false
  }
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

export function csrfCookieHeader(token: string): string {
  return `${CSRF_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`
}

export interface ConsentPageInput {
  clientName: string
  logoUri?: string
  scopes: string[]
  csrfToken: string
  handle: string
}

export function renderConsentPage(input: ConsentPageInput): string {
  const logo = isSafeLogoUri(input.logoUri)
    ? `<img class="logo" src="${escapeHtml(input.logoUri)}" alt="">`
    : ''
  const scopes = input.scopes.length
    ? `<p class="scopes">Requested access: <code>${input.scopes.map(escapeHtml).join('</code>, <code>')}</code></p>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Voc</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; background: #f5f4f0; color: #1d1c1a;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; max-width: 26rem; padding: 2rem 2.25rem; border-radius: 12px;
          box-shadow: 0 1px 3px rgb(0 0 0 / 12%); }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  .logo { max-width: 48px; max-height: 48px; }
  .scopes code { background: #f0efea; padding: .1rem .35rem; border-radius: 4px; }
  form { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { flex: 1; padding: .6rem 1rem; border-radius: 8px; border: 1px solid #c9c7c0;
           background: #fff; font: inherit; cursor: pointer; }
  button.approve { background: #2c6e49; border-color: #2c6e49; color: #fff; font-weight: 600; }
  button.approve:hover { background: #25593c; }
  button.deny:hover { background: #f0efea; }
</style>
</head>
<body>
<main class="card">
  ${logo}
  <h1>Connect to Voc</h1>
  <p><strong>${escapeHtml(input.clientName)}</strong> is asking to connect to your Voc account.</p>
  <p>Approving lets it record and manage your vocabulary records on your behalf — within
  your account's own permissions. It cannot grade reviews or change your Voc sign-in.</p>
  ${scopes}
  <form method="post" action="/authorize/consent">
    <input type="hidden" name="handle" value="${escapeHtml(input.handle)}">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <button name="decision" value="approve" class="approve">Connect</button>
    <button name="decision" value="deny" class="deny">Cancel</button>
  </form>
</main>
</body>
</html>`
}

export function renderErrorPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; background: #f5f4f0; color: #1d1c1a;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; max-width: 26rem; padding: 2rem 2.25rem; border-radius: 12px;
          box-shadow: 0 1px 3px rgb(0 0 0 / 12%); }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
</style>
</head>
<body>
<main class="card">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</main>
</body>
</html>`
}
