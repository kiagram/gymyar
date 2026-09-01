/* Type a number, get a code, type the code. Twice in this app, so once here.
 *
 * The sign-in screen uses it to create or open an account; Settings uses it to attach a number
 * to an account somebody is already signed in to. What is shared is everything a person sees:
 * the two fields, the countdown on the resend button, the guesses-remaining line, and the rule
 * that both fields are Latin digits and left to right whatever the layout is doing.
 *
 * What is *not* shared is what the two calls mean, so both are props. This component knows how
 * to ask and how to wait; it does not know what a code buys.
 *
 * ## The third step
 *
 * Signup has one — a new number is asked for a name — and attaching a number does not. Rather
 * than teach this component about names, `verify` may throw an error whose `code` matches
 * `moreOn`, and the parent then renders `more` in place of the code step and calls `submit`
 * again when its own field is filled. The code is still live at that point (the server rolls
 * the claim back), which is the whole reason that flow is worth having.
 */
import { useState, useRef, useEffect } from 'react'
import { isIranianMobile, maskPhone, latinDigits } from '@gymyar/domain'
import { t } from '../lib/i18n.js'
import { Button } from './ui.jsx'

/* Both fields, always. The sheet mirrors under Persian and a phone number does not:
 * `09123456789` is read left to right in Tehran exactly as it is anywhere else, and a number
 * that reflows as you type it is a field people retype. */
const digits = { dir: 'ltr', inputMode: 'numeric', style: { textAlign: 'center', letterSpacing: '.08em' } }

export default function PhoneCode({
  title,                 // the heading on the first step
  blurb,                 // one line under it
  sendLabel,             // what the first button says
  start,                 // async phone => { resendIn }
  verify,                // async (phone, code) => void, or throws
  moreOn = null,         // an error `code` that means "render `more` instead of failing"
  more = null            // ({ submit, busy, err }) => JSX
}) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState('phone')
  const [resendIn, setResendIn] = useState(0)
  const [left, setLeft] = useState(null)        // guesses remaining, once one has been used
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const codeRef = useRef(null)

  /* The countdown. The server decides the cooldown and says how long it is; this only counts
   * it down, so a screen and a limiter cannot disagree about when the button comes back. */
  useEffect(() => {
    if (resendIn <= 0) return
    const id = setInterval(() => setResendIn(n => Math.max(0, n - 1)), 1000)
    return () => clearInterval(id)
  }, [resendIn > 0])

  const send = async () => {
    if (!isIranianMobile(phone)) { setErr(t('Enter an Iranian mobile number, like 09123456789')); return }
    setBusy(true); setErr(null)
    try {
      const r = await start(phone)
      setResendIn(r?.resendIn || 60)
      setLeft(null); setCode('')
      setStep('code')
      setTimeout(() => codeRef.current?.focus(), 250)
    } catch (e) {
      // A throttled request carries how long to wait, so the button can say it rather than
      // making somebody guess.
      if (e.details?.retryAfter) setResendIn(e.details.retryAfter)
      setErr(e.message)
    } finally { setBusy(false) }
  }

  const submit = async () => {
    setBusy(true); setErr(null)
    try { await verify(phone, code) }
    catch (e) {
      if (moreOn && e.code === moreOn) { setStep('more'); setErr(null) }
      else {
        if (typeof e.details?.attemptsLeft === 'number') setLeft(e.details.attemptsLeft)
        setErr(e.message)
      }
    } finally { setBusy(false) }
  }

  if (step === 'more' && more) return more({ submit, busy, err })

  if (step === 'phone') return <>
    <h3>{title}</h3>
    {blurb && <div className="muted small" style={{ marginBottom: 14 }}>{blurb}</div>}
    <input className="input" type="tel" autoComplete="tel" maxLength={20} {...digits}
           placeholder="09123456789" value={phone}
           onChange={e => setPhone(e.target.value)}
           onKeyDown={e => e.key === 'Enter' && send()} />
    {err && <p className="err small" style={{ textAlign: 'left' }}>{err}</p>}
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy} onClick={send}>
      {busy ? t('Working…') : sendLabel}
    </Button>
  </>

  return <>
    <h3>{t('Enter the code')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Sent to {0}. It expires in five minutes.', maskPhone(phone))}
    </div>
    <input ref={codeRef} className="input" type="text" autoComplete="one-time-code" maxLength={6}
           {...digits} style={{ ...digits.style, fontSize: 24, fontWeight: 600, letterSpacing: '.3em' }}
           placeholder="······" value={code}
           /* Latin digits on the way in, so a code typed on a Persian keyboard fills the field
              rather than being silently rejected six characters later. */
           onChange={e => setCode(latinDigits(e.target.value).replace(/[^0-9]+/g, ''))}
           onKeyDown={e => e.key === 'Enter' && code.length === 6 && submit()} />
    {left !== null && left > 0 && <div className="dim small" style={{ marginTop: 6 }}>
      {t('{0} tries left before this code stops working.', left)}
    </div>}
    {err && <p className="err small" style={{ textAlign: 'left' }}>{err}</p>}
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy || code.length !== 6} onClick={submit}>
      {busy ? t('Working…') : t('Continue')}
    </Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" disabled={busy || resendIn > 0} onClick={send}>
      {resendIn > 0 ? t('Send a new code in {0}s', resendIn) : t('Send a new code')}
    </Button>
    <Button variant="ghost" className="dim" onClick={() => { setStep('phone'); setErr(null) }}>
      {t('Use a different number')}
    </Button>
  </>
}
