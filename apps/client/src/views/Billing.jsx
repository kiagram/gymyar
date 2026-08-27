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
  fmtToman, fmtUntil, termLabel, tierLabel, extendedTo, PAYMENT_STATUS
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
function Term({ term, cheapestPerMonth, until, busy, onBuy }) {
  const saving = cheapestPerMonth && term.perMonthToman > cheapestPerMonth
    ? null
    : term.months > 1 ? t('best value') : null

  /* What the money actually buys, as a date. A per-month figure answers "is this good value";
   * this answers "what do I get", which is the question somebody about to pay is asking. It
   * stacks onto whatever is left, so a coach with three weeks in hand can see for themselves
   * that waiting until they run out buys them nothing. */
  const lines = [
    term.months > 1 ? t('{0} per month', fmtToman(term.perMonthToman)) : null,
    t('Extends your subscription to {0}', fmtUntil(extendedTo(until, term.months)))
  ].filter(Boolean)

  return (
    <Row
      title={termLabel(term.months)}
      subtitle={lines.join(' · ')}
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

/**
 * Which size of plan, before which length of it.
 *
 * Two decisions rather than a nine-cell grid: a grid of tier × term is nine prices to compare
 * at once on a phone, and the two choices are not the same kind of choice. How many clients you
 * coach is a fact about your business; how long you pay for at a time is a preference. Picking
 * the fact first leaves three prices on screen instead of nine.
 */
function TierPicker({ tiers, selected, capacity, onSelect }) {
  return (
    <Section title={t('How many clients')}>
      {tiers.map(x => {
        const cheapest = Math.min(...x.terms.map(term => term.perMonthToman))
        const tooSmall = capacity?.used > x.clientCap
        return (
          <Row
            key={x.tier}
            icon={x.tier === selected ? 'checkCircle' : 'dot'}
            iconTint={tooSmall ? 'var(--orange)' : undefined}
            title={tierLabel(x.clientCap)}
            subtitle={tooSmall
              ? t('This plan is smaller than your roster, so you could not take on anyone new.')
              /* "from", because this is the cheapest term's rate and the shortest term costs
               * more. Quoting the annual rate as "per month" beside a monthly price that is
               * half as much again is the kind of thing a reader notices at the moment they
               * were deciding whether to trust the number. */
              : t('from {0} per month', fmtToman(cheapest))}
            onClick={() => onSelect(x.tier)}
          />
        )
      })}
    </Section>
  )
}

export default function Billing() {
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState(null)
  const [tier, setTier] = useState(null)
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

  /* Which size of plan this screen opens on.
   *
   * In order: the one they were sent here to buy — the cap refusal in the roster puts it on the
   * URL, and landing on anything else would make them find it again after being told exactly
   * what they needed. Then whatever they are already on, because a renewal is the common case
   * and it should be one tap. Then the smallest one that would actually fit the clients they
   * have, because offering somebody with twelve clients a five-client plan by default is
   * offering them something that cannot work.
   */
  useEffect(() => {
    if (!data?.tiers?.length || tier) return
    const asked = params.get('tier')
    const has = id => data.tiers.some(x => x.tier === id)
    const fits = data.tiers.find(x => x.clientCap >= (data.capacity?.used ?? 0))
    setTier(
      (asked && has(asked) && asked) ||
      (has(data.capacity?.tier) && data.capacity.tier) ||
      fits?.tier ||
      data.tiers[data.tiers.length - 1].tier
    )
  }, [data, tier, params])

  const buy = async months => {
    setBusy(true); setErr(null)
    // Clearing the outcome first: the next thing that happens is a full navigation to the
    // gateway, and coming back to a stale "payment cancelled" from the previous attempt would
    // be the app contradicting itself.
    if (outcome) { params.delete('billing'); setParams(params, { replace: true }) }
    try { await checkout(months, tier) }
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
  const tiers = data.tiers || []
  const chosen = tiers.find(x => x.tier === tier) || tiers[0]
  // `data.terms` is the pre-tier shape and still arrives; it is the fallback for an instance
  // whose API is older than this screen, not the normal path.
  const terms = chosen?.terms || data.terms || []
  const cheapest = terms.length ? Math.min(...terms.map(x => x.perMonthToman)) : null
  const capOf = id => tiers.find(x => x.tier === id)?.clientCap

  return (
    <div className="view">
      {head}

      {outcome && <Notice tone={outcome.tone} title={outcome.message} />}
      {err && <p className="err small">{err}</p>}

      {status && <Notice tone={status.tone} title={status.title} detail={status.detail} />}

      {!data.enabled ? (
        /* No gateway on this instance — a self-hosted GymYar. There is nothing to sell and
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

          {tiers.length > 1 && (
            <TierPicker tiers={tiers} selected={tier} capacity={data.capacity} onSelect={setTier} />
          )}

          <Section
            title={data.entitlement.state === 'active' ? t('Extend') : t('Choose a term')}
            footer={t('Longer terms cost less per month. Time you have already paid for is never lost — a renewal is added on top of it.')}
          >
            {terms.map(term => (
              <Term key={term.months} term={term} cheapestPerMonth={cheapest}
                    until={data.entitlement?.until} busy={busy} onBuy={buy} />
            ))}
          </Section>

          {busy && <p className="dim small">{t('Opening the payment page…')}</p>}

          {!!data.payments.length && (
            <Section title={t('Payments')}>
              {data.payments.map(p => (
                <Row
                  key={p.id}
                  title={termLabel(p.months)}
                  subtitle={[fmtUntil(p.at), p.tier && capOf(p.tier) != null
                    ? tierLabel(capOf(p.tier)) : null].filter(Boolean).join(' · ')}
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
