import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { webauthnOK, passkeyLogin, passkeyRegister, passwordLogin, passwordRegister, api, BIO } from '../lib/api.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { useState, useRef, useEffect } from 'react'
import { Button } from '../components/ui.jsx'
import mark from '../assets/mark.svg'

/* What happens after any successful sign-in, whichever way it happened.
 *
 * The interesting case is a guest who already has training on this device: their data has to
 * become the new account's rather than being replaced by an empty one. A full sync sends it up
 * before pulling anything down. */
async function afterAuth(u, { created } = {}) {
  const { setUser, syncNow, S } = useStore.getState()
  setUser(u)
  const carriedData = hasData(S)
  await syncNow({ full: true })
  useUI.getState().toast(
    carriedData && created ? t('Profile created — data from this device moved into it')
      : created ? t('Welcome, {0}', u.name)
      : t('Welcome back, {0}', u.name))
}

function PasswordSheet({ close, mode }) {
  const [signUp, setSignUp] = useState(mode === 'signup')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [asCoach, setAsCoach] = useState(false)
  const [inviteOnly, setInviteOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  useEffect(() => { api('/api/config').then(c => setInviteOnly(!!c.inviteOnly)).catch(() => {}) }, [])

  const go = async () => {
    setBusy(true); setErr(null)
    try {
      const u = signUp
        ? await passwordRegister({ name: name.trim(), email: email.trim(), password, code: code.trim(), asCoach })
        : await passwordLogin({ email: email.trim(), password })
      await afterAuth(u, { created: signUp })
      close()
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return <>
    <h3>{signUp ? t('Create an account') : t('Sign in')}</h3>
    {signUp && (
      <input className="input" placeholder={t('Your name')} maxLength={40}
             value={name} onChange={e => setName(e.target.value)} />
    )}
    {signUp && <div style={{ height: 10 }} />}
    <input className="input" type="email" inputMode="email" autoComplete="email"
           placeholder={t('Email')} value={email} onChange={e => setEmail(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password"
           autoComplete={signUp ? 'new-password' : 'current-password'}
           placeholder={t('Password')} value={password} onChange={e => setPassword(e.target.value)} />
    {signUp && <div className="dim small" style={{ marginTop: 6, textAlign: 'left' }}>
      {t('At least 10 characters.')}
    </div>}
    {signUp && inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
             onChange={e => setCode(e.target.value.toUpperCase())}
             style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
    </>}
    {signUp && <>
      <div style={{ height: 12 }} />
      <label className="dim small" style={{ display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left' }}>
        <input type="checkbox" checked={asCoach} onChange={e => setAsCoach(e.target.checked)} />
        {t('I coach other people')}
      </label>
    </>}
    {err && <p className="err small" style={{ textAlign: 'left' }}>{err}</p>}
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy} onClick={go}>
      {busy ? t('Working…') : signUp ? t('Create account') : t('Sign in')}
    </Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={() => { setErr(null); setSignUp(v => !v) }}>
      {signUp ? t('I already have an account') : t('Create one instead')}
    </Button>
  </>
}

function RegisterSheet({ close }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [inviteOnly, setInviteOnly] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  useEffect(() => { api('/api/config').then(c => setInviteOnly(!!c.inviteOnly)).catch(() => {}) }, [])
  const go = async () => {
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    if (inviteOnly && !code.trim()) { useUI.getState().toast(t('An invite code is required')); return }
    try {
      const u = await passkeyRegister(n, code.trim())
      close()
      await afterAuth(u, { created: true })
    } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Registration failed')) }
  }
  return <>
    <h3>{t('Create your profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name, then confirm with {0}. The passkey is saved in your device — no password needed.', BIO)}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div>
    </>}
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go}>{t('Create passkey')}</Button>
  </>
}

export default function Login() {
  const setGuest = useStore(s => s.setGuest)
  const openSheet = useUI(s => s.openSheet)
  const signIn = async () => {
    try { const u = await passkeyLogin(); await afterAuth(u) }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Sign-in failed')) }
  }
  const withPassword = mode => openSheet(close => <PasswordSheet close={close} mode={mode} />)
  const head = <>
    {/* The mark, not the accent: a logo is one colour whatever accent the profile picked. */}
    <div style={{ display: 'flex', justifyContent: 'center' }}><img src={mark} alt="" height="64" /></div>
    <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>GymBuddy</h1>
  </>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo — everything stays in this browser.')}</div>
      <Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'left', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Passkey sign-in and sync across your devices come with the GymBuddy server, which you get by self-hosting it.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 34 }}>{t('Your workouts. Your weights. Your profile.')}</div>
      {webauthnOK() && <>
        <Button variant="primary" icon="person" onClick={signIn}>{t('Sign in with passkey')}</Button>
        <div style={{ height: 10 }} />
        <Button icon="sparkles" onClick={() => openSheet(close => <RegisterSheet close={close} />)}>{t('Create new profile')}</Button>
        <div style={{ height: 10 }} />
      </>}
      <Button icon="key" onClick={() => withPassword(webauthnOK() ? 'signin' : 'signup')}>
        {t('Use email and password')}
      </Button>
      <div style={{ height: 10 }} />
      <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>
      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>
        {webauthnOK()
          ? <>{t('Passkeys use {0} — no passwords.', BIO)}<br /></>
          : <>{t("This browser doesn't support passkeys, so email and password it is.")}<br /></>}
        {t('Each profile keeps its own plan, workouts & body weight.')}
      </div>
    </div>
  )
}
