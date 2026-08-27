// Backend + WebAuthn helpers (ported from the vanilla app).
import { MOBILE } from './mobile.js'
import { getLang } from './i18n.js'
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)
/* These are translation *keys*, not finished text, and callers must render them through `t()`.
 *
 * They cannot be translated here: this module is imported at boot, before a locale pack has
 * loaded, so a `t()` at this line would freeze the English into a constant. Interpolating them
 * raw is what put "پس‌کی‌ها از your fingerprint, face or PIN استفاده می‌کنند" on the sign-in
 * screen — a Persian sentence with an English clause inside it, which reads worse than either
 * language alone would.
 *
 * Being keys assembled at runtime, they are invisible to a scan for `t('…')` literals, so the
 * locale packs carry them by hand. Apple's and Google's product names stay as they are: they
 * are brands, and Persian writes them that way too. */
export const BIO = IS_APPLE ? 'Face ID / Touch ID' : IS_ANDROID ? 'fingerprint or face unlock' : 'your fingerprint, face or PIN'
export const VAULT = IS_APPLE ? 'iCloud Keychain' : IS_ANDROID ? 'Google Password Manager' : 'your password manager'
export const webauthnOK = () => !!(window.PublicKeyCredential && navigator.credentials)

/* The native build has no backend, and this is where that stops being a convention.
 *
 * Every caller is already behind a `MOBILE` check or a screen the native build cannot reach,
 * so nothing here should ever run — but "should" is not what you want underneath a privacy
 * declaration that says the app transmits nothing. A thrown error is a claim the code enforces:
 * a future screen that forgets the check fails loudly in development instead of quietly
 * calling a server that is not there, and the store listing stays true without anybody having
 * to re-audit it.
 */
export async function api(path, opts) {
  if (MOBILE) throw new Error(`the native build has no backend (tried ${path})`)
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error(data.error || ('HTTP ' + r.status))
    e.status = r.status
    /* Carried through, not just the message. A 402 says *why* it refused in `details`, and a
     * screen that only has the sentence cannot tell an ended trial from a lapsed subscription
     * — which are the same refusal and want different buttons. */
    e.code = data.code || null
    e.details = data.details || null
    throw e
  }
  return data
}

/**
 * Send a file as a raw request body, with progress.
 *
 * `fetch` cannot report upload progress — there is no event for it — and this is the one place
 * in the app where that matters: a 60 MB form check on mobile data is a minute of somebody
 * staring at a screen, and a spinner that never moves is indistinguishable from a stall. So
 * this one call is XHR, deliberately, and everything else stays on fetch.
 *
 * The body is the file and nothing else. No multipart, no filename — the server builds the key
 * and sniffs the type, so a filename would be a field it has already decided never to read.
 * `application/octet-stream` is sent because it is the type that means "these are bytes",
 * which is exactly how much the server trusts it.
 */
export function upload(path, blob, { onProgress = null, signal = null } = {}) {
  if (MOBILE) throw new Error(`the native build has no backend (tried ${path})`)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total) }
    xhr.onload = () => {
      let data = {}
      try { data = JSON.parse(xhr.responseText) } catch { /* a proxy's error page, not ours */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data)
      const e = new Error(data.error || ('HTTP ' + xhr.status))
      e.status = xhr.status
      e.code = data.code || null
      reject(e)
    }
    xhr.onerror = () => reject(new Error('upload failed'))
    xhr.onabort = () => reject(Object.assign(new Error('upload cancelled'), { cancelled: true }))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(blob)
  })
}

const bufToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uToBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer

function toCreationOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  o.user.id = b64uToBuf(o.user.id)
  ;(o.excludeCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function toRequestOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  ;(o.allowCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function credToJSON(cred) {
  const r = cred.response
  const out = {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    authenticatorAttachment: cred.authenticatorAttachment || null,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON) }
  }
  if (r.attestationObject) {
    out.response.attestationObject = bufToB64u(r.attestationObject)
    out.response.transports = r.getTransports ? r.getTransports() : ['internal']
  }
  if (r.authenticatorData) {
    out.response.authenticatorData = bufToB64u(r.authenticatorData)
    out.response.signature = bufToB64u(r.signature)
    out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : null
  }
  return out
}
export async function passkeyRegister(name, code) {
  const { cid, options } = await api('/api/register/options', { method: 'POST', body: JSON.stringify({ name, code: code || '' }) })
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) })
  const res = await api('/api/register/verify', { method: 'POST', body: JSON.stringify({ cid, credential: credToJSON(cred) }) })
  return res.user
}
export async function passkeyLogin() {
  const { cid, options } = await api('/api/login/options', { method: 'POST', body: '{}' })
  const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) })
  const res = await api('/api/login/verify', { method: 'POST', body: JSON.stringify({ cid, credential: credToJSON(cred) }) })
  return res.user
}

/* Email + password. Passkeys remain the better option and the one the screen leads with, but
 * "create an account" cannot be a dead end on a browser or device that will not do WebAuthn —
 * which is the difference between a self-hosted tool and a product people sign up for. */
export async function passwordRegister({ name, email, password, code, asCoach }) {
  const res = await api('/api/register/password', {
    method: 'POST',
    body: JSON.stringify({
      name, email, password, code: code || '', asCoach: !!asCoach,
      // The language they are reading this form in. Sent at signup so the first note the
      // server writes for this account is already in it, rather than English until they
      // happen to open Settings.
      locale: getLang()
    })
  })
  return res.user
}

/**
 * Tell the server which language to write in.
 *
 * Only the server-generated prose depends on this — a coach's drafted note, a plan summary —
 * and everything else the app renders is translated on this side from packs it already has.
 * So a failure here is silent: the worst case is a sentence arriving in English, and there is
 * nothing a person could usefully be told about it mid-launch.
 */
export const setServerLocale = locale =>
  api('/api/me', { method: 'PATCH', body: JSON.stringify({ locale }) }).catch(() => null)

/* ------------------------------------------------------ password reset ---- */

/**
 * Ask for a reset link.
 *
 * Resolves the same way whether or not that address has an account — the server answers
 * identically on purpose, so that this endpoint cannot be used to find out who is a member.
 * Which means the screen cannot say "sent" honestly either, and says "if that address has an
 * account" instead.
 */
export const requestPasswordReset = email =>
  api('/api/password/forgot', { method: 'POST', body: JSON.stringify({ email }) })

/** Whether a link is still good, asked before somebody bothers choosing a password. */
export const checkResetToken = token =>
  api(`/api/password/reset/${encodeURIComponent(token)}`).then(r => !!r.valid)

/** Spend the link. Signs in on success — they have just proved the account is theirs. */
export const resetPassword = ({ token, password }) =>
  api('/api/password/reset', { method: 'POST', body: JSON.stringify({ token, password }) })
    .then(r => r.user)

export async function passwordLogin({ email, password }) {
  const res = await api('/api/login/password', {
    method: 'POST', body: JSON.stringify({ email, password })
  })
  return res.user
}
