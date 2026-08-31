/* The client's side of coaching: who can see what, invitations waiting, and the inbox of
 * programme changes a coach has proposed.
 *
 * This screen is where the product's central promise is either kept or broken. A coach never
 * writes here; nothing they send takes effect until the person whose training it is says so.
 * So the accept button shows exactly what will change, and revoking access is one tap away
 * from the same screen rather than buried in settings.
 */
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { Section, Row, Button, Check } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { t, exName } from '../lib/i18n.js'
import { fmtDate, fmtInt, normaliseHabit, EXIDX, modeOf } from '@gymyar/domain'
import {
  fetchCoaches, previewInvite, acceptInvite, declineInvite, updateScopes, endCoaching,
  acceptProposal, declineProposal, SCOPE_INFO
} from '../lib/coaching.js'

const exLabel = id => exName(EXIDX[id]) || id

/* A proposal is a routine or a habit, and this screen is the only place either one is
 * answered. `kind` is the column the server dispatches on when it applies one, so it is what
 * is read here too — a payload sniffed for its shape would describe one thing and accept
 * another the first time the two kinds grew a field in common.
 *
 * Everything below that switches on kind switches on this. A habit's payload has a `title`
 * and no `name`, which is why an unhandled kind did not fail loudly: it read as a programme
 * change with no exercises in it.
 */
const isHabit = p => p.kind === 'habit'

const titleOf = p => isHabit(p)
  ? (p.payload?.title || t('Habit'))
  : (p.payload?.name || t('Programme change'))

/* What accepting will actually do, side by side with what they have now. A proposal that
 * arrives as "your coach changed something" is a thing people click through; one that shows
 * the sets and reps is a thing they read. */
function ProposalDiff({ proposal, current }) {
  return isHabit(proposal)
    ? <HabitDiff proposal={proposal} current={current} />
    : <RoutineDiff proposal={proposal} current={current} />
}

/* The same idea for a habit, which has far less to it: a name and how many days a week it
 * asks for. `normaliseHabit` rather than the payload as sent, because that is the function the
 * server runs before it writes the row — a target proposed out of range is shown here as the
 * number that will actually land, rather than as a promise the accept quietly breaks.
 */
function HabitDiff({ proposal, current }) {
  const next = normaliseHabit(proposal.payload)
  const was = current && normaliseHabit(current)
  const days = n => t('{0} days a week', fmtInt(n))

  if (!next) return <div className="card small"><span className="dim">{t('Nothing to accept.')}</span></div>

  const changed = !was || was.target !== next.target
  return (
    <div className="card small" style={{ lineHeight: 1.7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span>
          {was && was.title !== next.title && (
            <span className="dim" style={{ textDecoration: 'line-through', marginRight: 6 }}>{was.title}</span>
          )}
          {next.title}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: changed ? 'var(--accent)' : 'var(--label-2)' }}>
          {was && changed && <span className="dim" style={{ textDecoration: 'line-through', marginRight: 6 }}>{days(was.target)}</span>}
          {days(next.target)}
          {!was && <span className="dim" style={{ marginLeft: 6 }}>{t('new')}</span>}
        </span>
      </div>
    </div>
  )
}

function RoutineDiff({ proposal, current }) {
  const next = proposal.payload?.exercises || []
  const before = current?.ex || []
  const beforeBy = new Map(before.map(e => [e.id, e]))
  const line = e => `${e.sets ?? '?'} × ${modeOf(e) === 'time' ? `${e.sec || 30}s` : (e.reps ?? '?')}`

  return (
    <div className="card small" style={{ lineHeight: 1.7 }}>
      {next.map((e, i) => {
        const was = beforeBy.get(e.id)
        const changed = !was || line(was) !== line(e)
        return (
          <div key={`${e.id}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>{exLabel(e.id)}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: changed ? 'var(--accent)' : 'var(--label-2)' }}>
              {was && changed && <span className="dim" style={{ textDecoration: 'line-through', marginRight: 6 }}>{line(was)}</span>}
              {line(e)}
              {!was && <span className="dim" style={{ marginLeft: 6 }}>{t('new')}</span>}
            </span>
          </div>
        )
      })}
      {before
        .filter(e => !next.some(n => n.id === e.id))
        .map(e => (
          <div key={`gone-${e.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }} className="dim">
            <span style={{ textDecoration: 'line-through' }}>{exLabel(e.id)}</span>
            <span>{t('removed')}</span>
          </div>
        ))}
      {!next.length && <span className="dim">{t('No exercises in this version.')}</span>}
    </div>
  )
}

function ProposalSheet({ proposal, close, onResolved }) {
  const toast = useUI(s => s.toast)
  const S = useStore(s => s.S)
  const syncNow = useStore(s => s.syncNow)
  const [busy, setBusy] = useState(false)
  const habit = isHabit(proposal)
  /* `subject_id` is whatever the proposal is about — a routine's id, or a habit's — which is
   * how the diff finds the version this one would replace. An archived habit still counts as
   * that version: accepting un-archives it rather than adding a second one, so showing it as
   * new would be the one thing the diff exists to prevent. */
  const current = habit
    ? (S.habits || []).find(h => h.id === proposal.subject_id)
    : (S.routines || []).find(r => r.id === proposal.subject_id)

  const act = async (fn, message) => {
    setBusy(true)
    try {
      await fn(proposal.id)
      // Accepting writes the row server-side, so the local copy is stale until we pull.
      await syncNow()
      toast(message)
      onResolved(); close()
    } catch (e) { toast(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="sheet-body">
      <h2>{titleOf(proposal)}</h2>
      <p className="dim small">
        {t('{0} proposed this on {1}', proposal.coach_name, fmtDate(proposal.proposed_at))}
      </p>
      {proposal.note && <p style={{ margin: '4px 0 12px' }}>“{proposal.note}”</p>}

      <ProposalDiff proposal={proposal} current={current} />

      {/* Four sentences rather than two, because "this routine" is the wrong noun for half of
          them and the sentence is the whole of what somebody is agreeing to. */}
      <p className="dim small">
        {habit
          ? (current
              ? t('Accepting replaces your version of this habit. Declining changes nothing.')
              : t('Accepting adds this habit to your list. Declining changes nothing.'))
          : (current
              ? t('Accepting replaces your version of this routine. Declining changes nothing.')
              : t('Accepting adds this routine to your plan. Declining changes nothing.'))}
      </p>

      <Button variant="primary" icon="check" disabled={busy}
              onClick={() => act(acceptProposal, habit ? t('Added to your habits') : t('Added to your plan'))}>
        {busy ? t('Working…') : t('Accept')}
      </Button>
      <Button icon="xmark" disabled={busy}
              onClick={() => act(declineProposal, t('Declined'))}>
        {t('Decline')}
      </Button>
      <Button onClick={close}>{t('Later')}</Button>
    </div>
  )
}

function ScopeSheet({ link, close, onSaved }) {
  const toast = useUI(s => s.toast)
  const [scopes, setScopes] = useState(link.scopes || [])
  const [busy, setBusy] = useState(false)
  const toggle = key => setScopes(cur => cur.includes(key) ? cur.filter(s => s !== key) : [...cur, key])

  const save = async () => {
    setBusy(true)
    try { await updateScopes(link.id, scopes); toast(t('Updated')); onSaved(); close() }
    catch (e) { toast(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="sheet-body">
      <h2>{t('What {0} can see', link.coach_name)}</h2>
      <Section>
        {Object.entries(SCOPE_INFO).map(([key, info]) => (
          <Row key={key} title={t(info.label)} subtitle={t(info.detail)} onClick={() => toggle(key)}>
            <Check checked={scopes.includes(key)} onChange={() => toggle(key)} />
          </Row>
        ))}
      </Section>
      <p className="dim small">{t('Turning something off takes effect immediately.')}</p>
      <Button variant="primary" disabled={busy} onClick={save}>{t('Save')}</Button>
      <Button onClick={close}>{t('Cancel')}</Button>
    </div>
  )
}

/* Reached from an invitation link. Shown before signing anything away: who is asking, and
 * exactly what they are asking for, each item individually refusable. */
export function InviteAccept() {
  const { code } = useParams()
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const user = useStore(s => s.user)
  const [invite, setInvite] = useState(null)
  const [scopes, setScopes] = useState([])
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    previewInvite(code)
      .then(r => { setInvite(r.invite); setScopes(r.invite.scopes) })
      .catch(e => setErr(e.message))
  }, [code])

  const toggle = key => setScopes(cur => cur.includes(key) ? cur.filter(s => s !== key) : [...cur, key])

  const accept = async () => {
    setBusy(true)
    try { await acceptInvite(code, scopes); toast(t('Connected')); nav('/coaching') }
    catch (e) { setErr(e.message); setBusy(false) }
  }
  const decline = async () => {
    try { await declineInvite(code) } catch { /* already gone */ }
    nav('/home')
  }

  if (!user) return (
    <div className="view">
      <header className="vhead"><h1>{t('Invitation')}</h1></header>
      <p>{t('Sign in first, then open this link again.')}</p>
      <Button variant="primary" onClick={() => nav('/home')}>{t('Go to sign in')}</Button>
    </div>
  )
  if (err) return (
    <div className="view">
      <header className="vhead"><h1>{t('Invitation')}</h1></header>
      <p className="err">{err}</p>
      <Button onClick={() => nav('/home')}>{t('Back')}</Button>
    </div>
  )
  if (!invite) return <div className="view"><p className="dim">{t('Loading…')}</p></div>

  return (
    <div className="view">
      <header className="vhead">
        <h1>{t('{0} wants to coach you', invite.coachName)}</h1>
      </header>
      <Section title={t('They are asking to see')}
               footer={t('Uncheck anything you would rather keep to yourself. You can change this later, or end the arrangement entirely.')}>
        {invite.scopes.map(key => (
          <Row key={key} title={t(SCOPE_INFO[key].label)} subtitle={t(SCOPE_INFO[key].detail)}
               onClick={() => toggle(key)}>
            <Check checked={scopes.includes(key)} onChange={() => toggle(key)} />
          </Row>
        ))}
      </Section>
      <Section footer={t('They can suggest changes to your programme. Nothing they send takes effect until you accept it.')}>
        <Row icon="shield" title={t('They can never edit your training directly')} />
      </Section>
      <Button variant="primary" icon="check" disabled={busy || !scopes.length} onClick={accept}>
        {busy ? t('Connecting…') : t('Accept')}
      </Button>
      <Button icon="xmark" onClick={decline}>{t('No thanks')}</Button>
      <div style={{ height: 24 }} />
    </div>
  )
}

export default function Coaching() {
  const nav = useNavigate()
  const openSheet = useUI(s => s.openSheet)
  const toast = useUI(s => s.toast)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  const load = async () => {
    try { setData(await fetchCoaches()); setErr(null) }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  const end = async link => {
    if (!confirm(t('Stop sharing with {0}? They lose access immediately.', link.coach_name))) return
    try { await endCoaching(link.id); toast(t('Ended')); load() }
    catch (e) { toast(e.message) }
  }

  if (err) return (
    <div className="view">
      <header className="vhead">
        <button className="back" onClick={() => nav('/settings')}><Icon name="chevronLeft" /></button>
        <h1>{t('Coaching')}</h1>
      </header>
      <p className="err">{err}</p>
    </div>
  )
  if (!data) return <div className="view"><p className="dim">{t('Loading…')}</p></div>

  const pending = data.coaches.filter(c => c.status === 'pending')
  const active = data.coaches.filter(c => c.status !== 'pending')

  return (
    <div className="view">
      <header className="vhead">
        <button className="back" onClick={() => nav('/settings')}><Icon name="chevronLeft" /></button>
        <div>
          <h1>{t('Coaching')}</h1>
          <div className="sub">{t('Who can see your training, and what they have suggested')}</div>
        </div>
      </header>

      {data.proposals.length > 0 && (
        <Section title={t('Waiting for you')}
                 footer={t('Nothing changes until you accept.')}>
          {data.proposals.map(p => (
            <Row key={p.id} icon={isHabit(p) ? 'check' : 'clipboard'} iconTint="var(--accent)"
                 title={titleOf(p)}
                 subtitle={t('From {0}{1}', p.coach_name, p.note ? ` · “${p.note}”` : '')}
                 accessory="chevron"
                 onClick={() => openSheet(close => (
                   <ProposalSheet proposal={p} close={close} onResolved={load} />
                 ))} />
          ))}
        </Section>
      )}

      {pending.length > 0 && (
        <Section title={t('Invitations')}>
          {pending.map(c => (
            <Row key={c.id} icon="personCircle" iconTint="var(--orange)"
                 title={t('{0} wants to coach you', c.coach_name)}
                 subtitle={c.scopes.map(s => t(SCOPE_INFO[s].label)).join(' · ')}
                 accessory="chevron"
                 onClick={() => nav(`/invite/${c.invite_code}`)} />
          ))}
        </Section>
      )}

      <Section title={t('Your coaches')}
               footer={active.length ? t('A coach can suggest changes; only you can apply them.') : undefined}>
        {active.length === 0 && (
          <Row icon="personCircle" title={t('Nobody has access')}
               subtitle={t('When a coach invites you, it shows up here first.')} />
        )}
        {active.map(c => (
          <Row key={c.id} icon="personCircle" title={c.coach_name}
               subtitle={c.scopes.map(s => t(SCOPE_INFO[s].label)).join(' · ')}
               accessory="chevron"
               onClick={() => openSheet(close => (
                 <ScopeSheet link={c} close={close} onSaved={load} />
               ))} />
        ))}
      </Section>

      {active.map(c => (
        <Section key={`end-${c.id}`}>
          <Row danger icon="xmark" title={t('Stop sharing with {0}', c.coach_name)}
               onClick={() => end(c)} />
        </Section>
      ))}

      <div style={{ height: 32 }} />
    </div>
  )
}
