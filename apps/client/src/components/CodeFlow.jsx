/* Type a destination, get a code, type the code. Three times in this app, so once here.
 *
 * The sign-in screen uses it to open or create an account from a phone number; Settings uses it
 * twice, to put a number or an address on an account somebody is already signed in to. What is
 * shared is the second step and everything around it: the code field, the countdown on the
 * resend button, the guesses-remaining line, and the rule that a code is Latin digits and reads
 * left to right whatever the layout is doing.
 *
 * What is not shared is the first step, because a phone number is one field and an address is
 * sometimes two — an account created by phone has no password, and an address without one
 * cannot sign anybody in. So the first step is a render prop and the parent owns whatever it
 * needs to collect. This component knows how to ask and how to wait; it does not know what a
 * code buys.
 *
 * ## The third step
 *
 * Signup has one — a new number is asked for a name — and neither Settings flow does. Rather
 * than teach this component about names, `verify` may throw an error whose `code` matches
 * `moreOn`, and the parent then renders `more` in place of the code step and calls `submit`
 * again when its own field is filled. The code is still live at that point, because the server
 * rolls the claim back when what it was for fails, which is the whole reason that step is
 * cheap enough to be worth having.
 */
import { useState, useRef, useEffect } from 'react'
import { latinDigits } from '@gymyar/domain'
import { t } from '../lib/i18n.js'
import { Button } from './ui.jsx'

/* Shared by every destination field a caller renders, and by the code field below. The sheet
 * mirrors under Persian and neither of these does: `09123456789` is read left to right in
 * Tehran exactly as it is anywhere else, an address is Latin by definition, and a field that
 * reflows as you type into it is a field people retype. */
export const ltrField = {
  dir: 'ltr', inputMode: 'numeric', style: { textAlign: 'center', letterSpacing: '.08em' }
}

export default function CodeFlow({
  sentTo,                // value => the string shown in "Sent to …"
  validate = () => null, // value => an error message, or null
  start,                 // async value => { resendIn }
  verify,                // async (value, code) => void, or throws
  first,                 // ({ value, setValue, send, busy, err }) => the whole first step
  moreOn = null,         // an error `code` that means "render `more` instead of failing"
  more = null            // ({ submit, busy, err }) => JSX
}) {
  const [value, setValue] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState('first')
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
    const complaint = validate(value)
    if (complaint) { setErr(complaint); return }
    setBusy(true); setErr(null)
    try {
      const r = await start(value)
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
    try { await verify(value, code) }
    catch (e) {
      if (moreOn && e.code === moreOn) { setStep('more'); setErr(null) }
      else {
        if (typeof e.details?.attemptsLeft === 'number') setLeft(e.details.attemptsLeft)
        setErr(e.message)
      }
    } finally { setBusy(false) }
  }

  if (step === 'more' && more) return more({ submit, busy, err })
  if (step === 'first') return first({ value, setValue, send, busy, err })

  return <>
    <h3>{t('Enter the code')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Sent to {0}. It expires in five minutes.', sentTo(value))}
    </div>
    <input ref={codeRef} className="input" type="text" autoComplete="one-time-code" maxLength={6}
           {...ltrField} style={{ ...ltrField.style, fontSize: 24, fontWeight: 600, letterSpacing: '.3em' }}
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
    <Button variant="ghost" className="dim" onClick={() => { setStep('first'); setErr(null) }}>
      {t('Start over')}
    </Button>
  </>
}
