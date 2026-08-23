/* The subscription screen: what you have, what it costs to keep it, and what you have paid.
 *
 * It is reachable from the coach roster and from anything that refused for want of payment, so
 * it has to make sense as both a page somebody chose to open and a page somebody was sent to
 * mid-task. That is why the state comes first and the prices second: a person who arrived here
 * because a button stopped working needs to know why before they are asked for money.
 *
 * The one thing this screen is careful never to imply: that training is at risk. It is not, for
 * anybody, ever. The footer says so, because a paywall that leaves the reader unsure whether
 * their own logged sets are hostage is a paywall that loses the customer and deserves to.
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Section, Row, Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { t } from '../lib/i18n.js'
import {
  fetchBilling, checkout, describeEntitlement, readOutcome,
  fmtToman, fmtUntil, termLabel, PAYMENT_STATUS
} from '../lib/billing.js'

function Notice({ tone = 'ok', title, detail }) {
  return (
    <div className={'notice ' + tone}>
      {title && <p className="notice-t">{title}</p>}
      {detail && <p className="notice-d">{detail}</p>}
    </div>
  )
}

/** One purchasable term. The saving is stated rather than left as arithmetic for the reader. */
function Term({ term, cheapestPerMonth, busy, onBuy }) {
  const saving = cheapestPerMonth && term.perMonthToman > cheapestPerMonth
    ? null
    : term.months > 1 ? t('best value') : null

  return (
    <Row
      title={termLabel(term.months)}
      subtitle={term.months > 1
        ? t('{0} per month', fmtToman(term.perMonthToman))
        : null}
      onClick={busy ? undefined : () => onBuy(term.months)}
      accessory="chevron"
    >
      <span className="lrow-v" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {fmtToman(term.toman)}
        {saving && <span className="dim small" style={{ marginInlineStart: 6 }}>{saving}</span>}
      </span>
    </Row>
  )
}

export default function Billing() {
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  // The gateway sends them back to /#/coach?billing=…; the roster forwards that here so this
  // screen is the one place that has to know what those words mean.
  const outcome = readOutcome(params.get('billing'))

  const load = async () => {
    try { setData(await fetchBilling()); setErr(null) }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  const buy = async months => {
    setBusy(true); setErr(null)
    // Clearing the outcome first: the next thing that happens is a full navigation to the
    // gateway, and coming back to a stale "payment cancelled" from the previous attempt would
    // be the app contradicting itself.
    if (outcome) { params.delete('billing'); setParams(params, { replace: true }) }
    try { await checkout(months) }
    catch (e) { setErr(e.message); setBusy(false) }
  }

  const head = (
    <header className="vhead"><h1>{t('Subscription')}</h1></header>
  )

  if (err && !data) return (
    <div className="view">
      {head}
      <p className="err">{err}</p>
      <Button onClick={load}>{t('Try again')}</Button>
    </div>
  )

  if (!data) return (
    <div className="view">{head}<p className="dim">{t('Loading…')}</p></div>
  )

  const status = describeEntitlement(data.entitlement)
  const cheapest = data.terms.length
    ? Math.min(...data.terms.map(x => x.perMonthToman))
    : null

  return (
    <div className="view">
      {head}

      {outcome && <Notice tone={outcome.tone} title={outcome.message} />}
      {err && <p className="err small">{err}</p>}

      {status && <Notice tone={status.tone} title={status.title} detail={status.detail} />}

      {!data.enabled ? (
        /* No gateway on this instance — a self-hosted GymBuddy. There is nothing to sell and
         * saying "subscribe" would be asking for money nobody can take. */
        <Section>
          <div style={{ padding: '28px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 34, color: 'var(--label-3)' }}><Icon name="checkCircle" /></div>
            <p style={{ margin: '10px 0 4px', fontWeight: 600 }}>{t('Everything is included here')}</p>
            <p className="dim small" style={{ margin: 0 }}>
              {t('This instance does not take payments. Coaching and training are both free on it.')}
            </p>
          </div>
        </Section>
      ) : (
        <>
          {data.sandbox && (
            <Notice
              tone="warn"
              title={t('Test mode')}
              detail={t('Payments here go to the gateway’s sandbox. No real money moves.')}
            />
          )}

          <Section
            title={data.entitlement.state === 'active' ? t('Extend') : t('Choose a term')}
            footer={t('Longer terms cost less per month. Time you have already paid for is never lost — a renewal is added on top of it.')}
          >
            {data.terms.map(term => (
              <Term key={term.months} term={term} cheapestPerMonth={cheapest}
                    busy={busy} onBuy={buy} />
            ))}
          </Section>

          {busy && <p className="dim small">{t('Opening the payment page…')}</p>}

          {!!data.payments.length && (
            <Section title={t('Payments')}>
              {data.payments.map(p => (
                <Row
                  key={p.id}
                  title={termLabel(p.months)}
                  subtitle={fmtUntil(p.at)}
                >
                  <span className="lrow-v dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {(PAYMENT_STATUS[p.status] || (() => p.status))()}
                  </span>
                </Row>
              ))}
            </Section>
          )}
        </>
      )}

      <p className="dim small" style={{ padding: '0 4px' }}>
        {t('Your own training is free and always will be — logging, programmes, history and stats are never part of a subscription. This covers coaching other people.')}
      </p>
      <div style={{ height: 24 }} />
    </div>
  )
}
