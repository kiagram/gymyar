/* Instance admin: who is on this server, and the invite codes that gate signup.
 *
 * Rewritten against the Postgres API. openGym's version read a JSON file and could afford to
 * show live presence from an in-memory map; this one asks the database, so it shows what the
 * database can actually answer for — sessions logged and when someone last trained.
 *
 * Off unless a user is flagged is_admin, so a fresh instance stays open with no admin at all.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { Section, Row, Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { fmtDate, fmtNum } from '@gymbuddy/domain'
import { daysSince } from '../lib/coaching.js'

const lastSeen = at => {
  const d = daysSince(at)
  if (d == null) return t('never trained')
  if (d === 0) return t('trained today')
  if (d === 1) return t('trained yesterday')
  return t('{0} days ago', d)
}

export default function Admin() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const [users, setUsers] = useState(null)
  const [invites, setInvites] = useState([])
  const [revenue, setRevenue] = useState(null)
  const [err, setErr] = useState(null)

  const loadUsers = () => api('/api/admin/users')
    .then(d => { setUsers(d.users); setErr(null) })
    .catch(e => setErr(e.message))
  const loadInvites = () => api('/api/admin/invites').then(d => setInvites(d.invites)).catch(() => {})
  // Swallowed like the invites above: an instance that takes no money has nothing here, and
  // that is not a failure worth a red sentence at the top of the screen.
  const loadRevenue = () => api('/api/admin/revenue').then(setRevenue).catch(() => {})

  useEffect(() => {
    if (!user?.isAdmin) return
    loadUsers(); loadInvites(); loadRevenue()
    // Cheap enough to poll, and an admin watching a signup land wants it to appear.
    const iv = setInterval(loadUsers, 15000)
    return () => clearInterval(iv)
  }, [user?.isAdmin])

  if (!user?.isAdmin) return null

  const toggleDisabled = async u => {
    const disabling = !u.disabled_at
    if (disabling && !confirm(t('Disable {0}? They are signed out everywhere immediately.', u.name))) return
    try {
      await api(`/api/admin/users/${u.id}/disable`, {
        method: 'POST', body: JSON.stringify({ disabled: disabling })
      })
      loadUsers()
    } catch (e) { toast(e.message) }
  }

  const newInvite = async () => {
    try {
      const { invite } = await api('/api/admin/invites', { method: 'POST', body: '{}' })
      await navigator.clipboard?.writeText(invite.code).catch(() => {})
      toast(t('Invite code {0} copied', invite.code))
      loadInvites()
    } catch (e) { toast(e.message) }
  }

  const revoke = async code => {
    try { await api(`/api/admin/invites/${code}`, { method: 'DELETE' }); loadInvites() }
    catch (e) { toast(e.message) }
  }

  const unused = invites.filter(i => !i.used_by)

  return (
    <div className="view">
      <header className="vhead">
        <button className="back" onClick={() => nav('/settings')}><Icon name="chevronLeft" /></button>
        <div>
          <h1>{t('Admin')}</h1>
          <div className="sub">{t('This instance')}</div>
        </div>
      </header>

      {err && <p className="err">{err}</p>}

      <Section title={t('People')} footer={users ? t('{0} accounts', users.length) : undefined}>
        {!users && <Row title={t('Loading…')} />}
        {users?.length === 0 && <Row title={t('Nobody has signed up yet')} />}
        {users?.map(u => (
          <Row
            key={u.id}
            icon={u.disabled_at ? 'lock' : u.is_coach ? 'clipboard' : 'personCircle'}
            iconTint={u.disabled_at ? 'var(--red)' : undefined}
            title={u.name + (u.is_admin ? ' · ' + t('admin') : '') + (u.is_coach ? ' · ' + t('coach') : '')}
            subtitle={`${u.email || t('passkey only')} · ${t('{0} sessions', u.sessions)} · ${lastSeen(u.last_trained_at)}`}
          >
            <Button size="xs" variant={u.disabled_at ? 'tinted' : 'danger'}
                    onClick={() => toggleDisabled(u)}>
              {u.disabled_at ? t('Enable') : t('Disable')}
            </Button>
          </Row>
        ))}
      </Section>

      {revenue && <RevenueSection revenue={revenue} />}

      <Section
        title={t('Invite codes')}
        footer={t('Codes only matter when the instance is set to invite-only. An unused code can be revoked; a used one is kept as a record.')}
      >
        {unused.length === 0 && <Row title={t('No unused codes')} />}
        {unused.map(i => (
          <Row key={i.code} icon="key" title={i.code} subtitle={t('created {0}', fmtDate(i.created_at))}>
            <Button size="xs" variant="danger" onClick={() => revoke(i.code)}>{t('Revoke')}</Button>
          </Row>
        ))}
        <Row icon="plus" title={t('Generate a code')} accessory="chevron" onClick={newInvite} />
      </Section>

      <div style={{ height: 32 }} />
    </div>
  )
}

/**
 * What has actually been collected, in both currencies.
 *
 * Two columns because one of them cannot answer the question. Toman is what was charged; the
 * dollar figure is what it was worth, and only the second can say whether revenue is growing
 * across a year in which the currency lost a third of its value.
 *
 * The dollar column is deliberately incomplete rather than estimated. A payment taken before
 * the price index existed has no rate on it and never will — the rate at that moment is not
 * recoverable — so those payments are counted in Toman, left out of dollars, and their number
 * is printed underneath. An invented rate would make the total look whole and be wrong.
 */
/* Three states, and the middle one is the reason this is a function rather than a ternary.
 *
 * A stale rate is still an index — prices are still moving with it — so calling it "not
 * indexed" would be a lie in the direction that matters, and it would hide the fact that the
 * long terms have quietly come off the price list. Whoever is reading this screen is the person
 * who can fix that, and they can only fix what they are told about. */
const footerFor = index => {
  const read = index.at ? fmtDate(index.at) : '—'
  if (index.usable) {
    return t('Prices are indexed at {0} Toman to the dollar, read {1}.', fmtNum(index.toman), read)
  }
  if (index.stale) {
    return t('The rate is out of date, so only the shortest term is on sale. Last read {0}.', read)
  }
  return t('Prices are not indexed, so they lose value as the rial does. Set TOMAN_PER_USD to hold it.')
}

function RevenueSection({ revenue }) {
  const { months, index } = revenue
  const unrated = months.reduce((n, m) => n + m.unrated, 0)
  const month = at => new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })

  return (
    <Section
      title={t('Revenue')}
      footer={footerFor(index)}
    >
      {months.length === 0 && <Row title={t('Nothing collected yet')} />}
      {months.map(m => (
        <Row
          key={m.month}
          icon="chartLine"
          title={month(m.month)}
          subtitle={t(m.payments === 1 ? '{0} payment' : '{0} payments', m.payments)}
          value={m.usd == null ? `${fmtNum(m.toman)} T` : `${fmtNum(m.toman)} T · $${fmtNum(m.usd)}`}
        />
      ))}
      {unrated > 0 && (
        <Row icon="info" title={t(unrated === 1
          ? '{0} payment recorded no rate, so it is missing from the dollar column'
          : '{0} payments recorded no rate, so they are missing from the dollar column', unrated)} />
      )}
    </Section>
  )
}
