// Backend + WebAuthn helpers (ported from the vanilla app).
import { MOBILE } from './mobile.js'
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)
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
    body: JSON.stringify({ name, email, password, code: code || '', asCoach: !!asCoach })
  })
  return res.user
}

export async function passwordLogin({ email, password }) {
  const res = await api('/api/login/password', {
    method: 'POST', body: JSON.stringify({ email, password })
  })
  return res.user
}
