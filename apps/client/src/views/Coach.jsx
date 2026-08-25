/* The coach's home screen: who is training, who has stopped, who is waiting on you.
 *
 * The ordering is the feature. A roster sorted by name is a list you have to read; sorted by
 * what needs attention, the top of the screen is the answer to "who do I message today".
 */
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { Section, Row, Button, TextField, Check } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { t } from '../lib/i18n.js'
import { fetchRoster, createInvite, SCOPE_INFO, daysSince } from '../lib/coaching.js'
import { fetchBilling, describeEntitlement, isPaymentRequired, isCapReached, capacityLabel } from '../lib/billing.js'

const WINDOW_DAYS = 28

/* Sort key: anything asking for a reply first, then the people drifting, then everyone else.
 * Lower sorts higher. */
function attentionRank(c) {
  if (c.status === 'pending') return 0
  const s = c.stats
  if (!s) return 5
  if (s.unreadMessages > 0) return 1
  const idle = daysSince(s.lastTrainedAt)
  if (idle == null || idle >= 10) return 2          // never started, or gone quiet
  if (s.adherence != null && s.adherence < 0.6) return 3
  return 4
}

function Adherence({ stats }) {
  if (!stats || stats.adherence == null) {
    // No weekly plan means no denominator. "—" is honest; 0% would read as "never trains".
    return <span className="lrow-v dim">{t('no schedule')}</span>
  }
  const pct = Math.round(stats.adherence * 100)
  const tone = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--orange)' : 'var(--red)'
  return (
    <span className="lrow-v" style={{ color: tone, fontVariantNumeric: 'tabular-nums' }}>
      {pct}%
    </span>
  )
}

function clientSubtitle(c) {
  if (c.status === 'pending') return t('Invitation not accepted yet')
  const s = c.stats
  if (!s) return null
  const idle = daysSince(s.lastTrainedAt)
  const bits = []
  bits.push(idle == null ? t('never trained')
    : idle === 0 ? t('trained today')
    : idle === 1 ? t('trained yesterday')
    : t('{0} days ago', idle))
  bits.push(t('{0} of {1} sessions', s.sessions, s.expected || '—'))
  if (s.unreadMessages) bits.push(t('{0} unread', s.unreadMessages))
  if (s.pendingProposals) bits.push(t('{0} awaiting reply', s.pendingProposals))
  return bits.join(' · ')
}

function InviteSheet({ close, nav }) {
  const toast = useUI(s => s.toast)
  const [email, setEmail] = useState('')
  const [scopes, setScopes] = useState(['programmes', 'workouts'])
  const [invite, setInvite] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const toggle = key => setScopes(cur =>
    cur.includes(key) ? cur.filter(s => s !== key) : [...cur, key])

  const submit = async () => {
    setBusy(true); setErr(null)
    try { setInvite((await createInvite({ email: email.trim() || null, scopes })).invite) }
    catch (e) {
      // A refusal for want of payment is not an error to read and dismiss — it is a thing to
      // go and fix. Sending them straight to the screen that fixes it beats a red sentence
      // with no way forward.
      if (isCapReached(e)) {
        toast(t('Your plan covers {0} clients — upgrade to take on more', e.details?.cap))
        // The size they need, carried to the screen that sells it. Being told what is wrong and
        // then having to work out which card fixes it is two steps where one will do.
        close(); nav(e.details?.nextTier ? `/billing?tier=${e.details.nextTier}` : '/billing')
      }
      else if (isPaymentRequired(e)) { close(); nav('/billing') }
      else setErr(e.message)
    }
    finally { setBusy(false) }
  }

  if (invite) {
    const link = `${location.origin}${location.pathname}#/invite/${invite.code}`
    return (
      <div className="sheet-body">
        <h2>{t('Invitation ready')}</h2>
        <p className="dim small">
          {t('Send this link to your client. They choose what to share when they accept.')}
        </p>
        <div className="card" style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 13 }}>
          {link}
        </div>
        <Button variant="primary" icon="link" onClick={() => {
          navigator.clipboard?.writeText(link)
          toast(t('Link copied'))
        }}>{t('Copy link')}</Button>
        <Button onClick={close}>{t('Done')}</Button>
      </div>
    )
  }

  return (
    <div className="sheet-body">
      <h2>{t('Invite a client')}</h2>
      <TextField
        type="email" inputMode="email" autoComplete="email" placeholder={t('Their email (optional)')}
        value={email} onChange={e => setEmail(e.target.value)}
      />
      <p className="dim small">
        {t('An email address lets the invitation show up in their app. Without one, send them the link yourself.')}
      </p>
      <Section title={t('Ask to see')}>
        {Object.entries(SCOPE_INFO).map(([key, info]) => (
          <Row key={key} title={t(info.label)} subtitle={t(info.detail)}
               onClick={() => toggle(key)}>
            <Check checked={scopes.includes(key)} onChange={() => toggle(key)} />
          </Row>
        ))}
      </Section>
      <p className="dim small">
        {t('They can grant less than you ask for, and change their mind at any time.')}
      </p>
      {err && <p className="err small">{err}</p>}
      <Button variant="primary" icon="link" disabled={busy || !scopes.length} onClick={submit}>
        {busy ? t('Creating…') : t('Create invitation')}
      </Button>
    </div>
  )
}

/* The way into the subscription screen, and the only place the roster mentions money.
 *
 * Hidden entirely on an instance with no gateway — `describeEntitlement` answers null for
 * `unbilled`, and a self-hosted GymBuddy should have no idea subscriptions exist. */
function SubscriptionRow({ billing, capacity, nav }) {
  const status = describeEntitlement(billing?.entitlement)
  if (!status) return null
  const tint = status.tone === 'stop' ? 'var(--red)' : status.tone === 'warn' ? 'var(--orange)' : undefined
  /* How full the plan is, beside how long is left on it. A coach who can see 23 of 25 coming is
   * not one who finds the ceiling halfway through inviting somebody. Absent on an uncapped
   * plan, where there is no number to count towards. */
  const used = capacityLabel(capacity)
  return (
    <Section>
      <Row
        icon="star" iconTint={tint}
        title={status.title} subtitle={status.detail}
        value={used || undefined}
        accessory="chevron" onClick={() => nav('/billing')}
      />
    </Section>
  )
}

export default function Coach() {
  const nav = useNavigate()
  const openSheet = useUI(s => s.openSheet)
  const user = useStore(s => s.user)
  const [params] = useSearchParams()
  const [clients, setClients] = useState(null)
  const [capacity, setCapacity] = useState(null)
  const [billing, setBilling] = useState(null)
  const [err, setErr] = useState(null)

  const load = async () => {
    try {
      const r = await fetchRoster(WINDOW_DAYS)
      setClients(r.clients); setCapacity(r.capacity); setErr(null)
    }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  /* Subscription state is loaded alongside the roster but never blocks it: whether somebody
   * has paid is not a reason to fail to show them their clients, and this request failing
   * should leave the screen exactly as it was before subscriptions existed. */
  useEffect(() => { fetchBilling().then(setBilling).catch(() => {}) }, [])

  /* The gateway redirects to /#/coach?billing=… because that is a URL that exists whether or
   * not the payer still has a session. Handing it straight on to the screen that explains it
   * keeps the wording in one file. */
  const outcome = params.get('billing')
  useEffect(() => {
    if (outcome) nav('/billing?billing=' + encodeURIComponent(outcome), { replace: true })
  }, [outcome])

  const invite = () => openSheet(close => <InviteSheet nav={nav} close={() => { close(); load() }} />)

  if (err) return (
    <div className="view">
      <header className="vhead"><h1>{t('Clients')}</h1></header>
      <p className="err">{err}</p>
      <Button onClick={load}>{t('Try again')}</Button>
    </div>
  )

  if (!clients) return (
    <div className="view">
      <header className="vhead"><h1>{t('Clients')}</h1></header>
      <p className="dim">{t('Loading…')}</p>
    </div>
  )

  const active = clients.filter(c => c.client_id)
  const sorted = [...clients].sort((a, b) => attentionRank(a) - attentionRank(b))

  return (
    <div className="view">
      <header className="vhead">
        <div>
          <h1>{t('Clients')}</h1>
          <div className="sub">
            {active.length
              ? t('{0} active · last {1} days', active.length, WINDOW_DAYS)
              : t('Nobody yet')}
          </div>
        </div>
      </header>

      {!clients.length ? (
        <>
        <Section>
          <div style={{ padding: '28px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 34, color: 'var(--label-3)' }}><Icon name="clipboard" /></div>
            <p style={{ margin: '10px 0 4px', fontWeight: 600 }}>{t('No clients yet')}</p>
            <p className="dim small" style={{ margin: '0 0 16px' }}>
              {t('Invite someone and their training shows up here — what they did, what they skipped, and what they still owe you an answer on.')}
            </p>
            <Button variant="primary" icon="plus" onClick={invite}>{t('Invite a client')}</Button>
          </div>
        </Section>
        <SubscriptionRow billing={billing} capacity={capacity} nav={nav} />
        </>
      ) : (
        <>
          <Section footer={t('Adherence compares finished sessions against the days their weekly plan has a routine on.')}>
            {sorted.map(c => (
              <Row
                key={c.id}
                icon={c.status === 'pending' ? 'clock' : 'personCircle'}
                iconTint={c.status === 'pending' ? 'var(--orange)' : undefined}
                title={c.client_name || c.invite_email || t('Invited')}
                subtitle={clientSubtitle(c)}
                accessory={c.client_id ? 'chevron' : 'none'}
                onClick={c.client_id ? () => nav(`/coach/${c.client_id}`) : undefined}
              >
                {c.client_id && <Adherence stats={c.stats} />}
              </Row>
            ))}
          </Section>
          <Section>
            <Row icon="plus" title={t('Invite a client')} accessory="chevron" onClick={invite} />
          </Section>
          <SubscriptionRow billing={billing} capacity={capacity} nav={nav} />
        </>
      )}
      <div style={{ height: 24 }} />
      <p className="dim small" style={{ textAlign: 'center' }}>
        {t('Signed in as {0}', user?.name || '')}
      </p>
    </div>
  )
}
