/* One client, as much of them as they have shared, and the two things a coach does here:
 * propose a change to a programme, and say something about a specific session.
 *
 * Every section is conditional on a scope. A missing section is stated rather than hidden —
 * "they have not shared this" is information a coach needs; a silently absent panel reads as
 * a bug and invites a support message.
 */
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useUI } from '../store/useUI.js'
import { Section, Row, Button, TextField, TextArea } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { t } from '../lib/i18n.js'
import { fmtDate, fmtNum, EXIDX, DAYN, setLabel, modeOf } from '@gymbuddy/domain'
import {
  fetchClient, proposeRoutine, fetchThread, sendMessage, SCOPE_INFO, daysSince
} from '../lib/coaching.js'

const exName = id => EXIDX[id]?.n || id

/* A routine's exercise list, rendered the same way in the read view and in the proposal
 * preview — so what a coach sends is visibly the thing they were just looking at. */
function ExerciseList({ exercises }) {
  if (!exercises?.length) return <p className="dim small">{t('No exercises yet')}</p>
  return (
    <ol className="dim small" style={{ margin: '4px 0 0', paddingLeft: 20, lineHeight: 1.7 }}>
      {exercises.map((e, i) => (
        <li key={`${e.id}-${i}`}>
          {exName(e.id)}
          {e.sets ? ` — ${e.sets} × ${modeOf(e) === 'time' ? `${e.sec || 30}s` : (e.reps ?? '?')}` : ''}
        </li>
      ))}
    </ol>
  )
}

function ProposeSheet({ clientId, routine, close, onDone }) {
  const toast = useUI(s => s.toast)
  const [name, setName] = useState(routine.name)
  const [note, setNote] = useState('')
  const [rows, setRows] = useState(() => (routine.exercises || []).map(e => ({ ...e })))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const patch = (i, key, value) =>
    setRows(cur => cur.map((r, j) => (j === i ? { ...r, [key]: value } : r)))
  const remove = i => setRows(cur => cur.filter((_, j) => j !== i))

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      await proposeRoutine(clientId, {
        routineId: routine.id,
        payload: { ...routine, name: name.trim() || routine.name, exercises: rows },
        note: note.trim() || null
      })
      toast(t('Sent to your client'))
      onDone(); close()
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="sheet-body">
      <h2>{t('Propose a change')}</h2>
      <p className="dim small">
        {t('Nothing changes on their side until they accept. Their own edits stay as they are in the meantime.')}
      </p>

      <TextField value={name} onChange={e => setName(e.target.value)} placeholder={t('Routine name')} />

      <Section title={t('Exercises')}>
        {rows.map((r, i) => (
          <Row key={`${r.id}-${i}`} title={exName(r.id)}>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input className="tf" style={{ width: 52, textAlign: 'center' }}
                     inputMode="numeric" value={r.sets ?? ''} aria-label={t('Sets')}
                     onChange={e => patch(i, 'sets', Number(e.target.value) || 0)} />
              <span className="dim">×</span>
              <input className="tf" style={{ width: 52, textAlign: 'center' }}
                     inputMode="numeric" value={r.reps ?? ''} aria-label={t('Reps')}
                     onChange={e => patch(i, 'reps', Number(e.target.value) || 0)} />
              <button className="icon-btn" aria-label={t('Remove')} onClick={() => remove(i)}>
                <Icon name="trash" />
              </button>
            </span>
          </Row>
        ))}
        {!rows.length && <p className="dim small" style={{ padding: '8px 16px' }}>{t('No exercises')}</p>}
      </Section>

      <TextArea rows={3} value={note} onChange={e => setNote(e.target.value)}
                placeholder={t('Why the change? (optional)')} />
      <p className="dim small">
        {t('The note is what they read first — it is the difference between a change and an instruction.')}
      </p>

      {err && <p className="err small">{err}</p>}
      <Button variant="primary" icon="upload" disabled={busy} onClick={submit}>
        {busy ? t('Sending…') : t('Send proposal')}
      </Button>
      <Button onClick={close}>{t('Cancel')}</Button>
    </div>
  )
}

function MessageSheet({ linkId, context, close }) {
  const toast = useUI(s => s.toast)
  const [messages, setMessages] = useState(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => { try { setMessages((await fetchThread(linkId)).messages) } catch { setMessages([]) } }
  useEffect(() => { load() }, [linkId])

  const send = async () => {
    const text = body.trim()
    if (!text) return
    setBusy(true)
    try { await sendMessage(linkId, text, context); setBody(''); await load(); toast(t('Sent')) }
    catch (e) { toast(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="sheet-body">
      <h2>{context?.workoutId ? t('About this session') : t('Messages')}</h2>
      <div style={{ maxHeight: '46vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages == null && <p className="dim small">{t('Loading…')}</p>}
        {messages?.length === 0 && <p className="dim small">{t('Nothing here yet.')}</p>}
        {messages?.map(m => (
          <div key={m.id} className="card small" style={{ margin: 0 }}>
            <strong>{m.sender_name}</strong>
            {m.workout_id && <span className="dim"> · {t('on a session')}</span>}
            <div>{m.body}</div>
          </div>
        ))}
      </div>
      <TextArea rows={3} value={body} onChange={e => setBody(e.target.value)}
                placeholder={t('Write a message')} />
      <Button variant="primary" icon="upload" disabled={busy || !body.trim()} onClick={send}>
        {busy ? t('Sending…') : t('Send')}
      </Button>
      <Button onClick={close}>{t('Close')}</Button>
    </div>
  )
}

function NotShared({ what }) {
  return (
    <Section title={t(SCOPE_INFO[what].label)}>
      <Row icon="lock" title={t('Not shared')}
           subtitle={t('Your client has not given you access to this. Ask them if you need it.')} />
    </Section>
  )
}

export default function CoachClient() {
  const { id } = useParams()
  const nav = useNavigate()
  const openSheet = useUI(s => s.openSheet)
  const [view, setView] = useState(null)
  const [err, setErr] = useState(null)

  const load = async () => {
    try { setView(await fetchClient(id)); setErr(null) }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [id])

  if (err) return (
    <div className="view">
      <header className="vhead">
        <button className="back" onClick={() => nav('/coach')}><Icon name="chevronLeft" /></button>
        <h1>{t('Client')}</h1>
      </header>
      <p className="err">{err}</p>
    </div>
  )
  if (!view) return <div className="view"><p className="dim">{t('Loading…')}</p></div>

  const { link, routines = [], workouts, bodyweight, weekPlan = [], proposals = [] } = view
  const scopes = link.scopes || []
  const weekBy = Object.fromEntries(weekPlan.map(w => [w.weekday, w.routine_id]))
  const recent = (workouts || []).slice(-8).reverse()
  const openMessages = ctx => openSheet(close => <MessageSheet linkId={link.id} context={ctx} close={close} />)

  return (
    <div className="view">
      <header className="vhead">
        <button className="back" onClick={() => nav('/coach')}><Icon name="chevronLeft" /></button>
        <div>
          <h1>{link.client_name || t('Client')}</h1>
          <div className="sub">{link.client_email}</div>
        </div>
      </header>

      <Section>
        <Row icon="bell" title={t('Messages')} accessory="chevron" onClick={() => openMessages({})} />
      </Section>

      {proposals.length > 0 && (
        <Section title={t('Waiting on them')}
                 footer={t('A proposal stays pending until your client accepts or declines it.')}>
          {proposals.map(p => (
            <Row key={p.id} icon="clock" iconTint="var(--orange)"
                 title={p.payload?.name || t('Programme change')}
                 subtitle={p.note || t('Sent {0}', fmtDate(p.proposed_at))} />
          ))}
        </Section>
      )}

      {scopes.includes('programmes') ? (
        <Section title={t('Programmes')}
                 footer={t('Editing here sends a proposal. It never overwrites what they are running.')}>
          {routines.length === 0 && (
            <Row icon="list" title={t('No routines yet')}
                 subtitle={t('Nothing to change until they build one, or you propose the first.')} />
          )}
          {routines.map(r => (
            <Row key={r.id} icon="list" title={r.name}
                 subtitle={t('{0} exercises', (r.exercises || []).length)}
                 accessory="chevron"
                 onClick={() => openSheet(close => (
                   <ProposeSheet clientId={id} routine={r} close={close} onDone={load} />
                 ))}>
              <span />
            </Row>
          ))}
        </Section>
      ) : <NotShared what="programmes" />}

      {scopes.includes('programmes') && weekPlan.length > 0 && (
        <Section title={t('Weekly schedule')}>
          {DAYN.map((day, i) => {
            const rid = weekBy[i]
            const r = routines.find(x => x.id === rid)
            return (
              <Row key={i} title={t(day)}
                   value={r ? r.name : t('Rest')}
                   className={r ? '' : 'dim'} />
            )
          })}
        </Section>
      )}

      {scopes.includes('workouts') ? (
        <Section title={t('Recent sessions')}
                 footer={recent.length ? t('Tap a session to comment on it.') : undefined}>
          {recent.length === 0 && (
            <Row icon="history" title={t('Nothing logged yet')} />
          )}
          {recent.map(w => {
            const sets = w.sets || []
            const idle = daysSince(w.finished_at || w.started_at)
            return (
              <Row key={w.id} icon="dumbbell"
                   title={w.routine_name || t('Session')}
                   subtitle={`${fmtDate(w.started_at)} · ${t('{0} sets', sets.length)}${
                     idle === 0 ? ` · ${t('today')}` : ''}`}
                   accessory="chevron"
                   onClick={() => openMessages({ workoutId: w.id })} />
            )
          })}
        </Section>
      ) : <NotShared what="workouts" />}

      {scopes.includes('bodyweight') ? (
        <Section title={t('Body weight')}>
          {(bodyweight || []).length === 0
            ? <Row icon="scale" title={t('No weigh-ins')} />
            : (bodyweight || []).slice(-5).reverse().map(b => (
                // keyed by date, not by id — body-weight rows have no synthetic id; (user, date)
                // is their primary key
                <Row key={b.on_date} icon="scale" title={fmtDate(b.on_date)}
                     value={`${fmtNum(Number(b.weight_kg))} kg`} />
              ))}
        </Section>
      ) : <NotShared what="bodyweight" />}

      <div style={{ height: 32 }} />
    </div>
  )
}
