/* One client, as much of them as they have shared, and the two things a coach does here:
 * propose a change to a programme, and say something about a specific session.
 *
 * Every section is conditional on a scope. A missing section is stated rather than hidden —
 * "they have not shared this" is information a coach needs; a silently absent panel reads as
 * a bug and invites a support message.
 */
import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useUI } from '../store/useUI.js'
import { Section, Row, Button, TextField, TextArea } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { t, exName, say } from '../lib/i18n.js'
import { fmtDate, fmtNum, EXIDX, DAYN, setLabel, modeOf } from '@gymbuddy/domain'
import {
  fetchClient, proposeRoutine, fetchThread, sendMessage, SCOPE_INFO, daysSince
} from '../lib/coaching.js'
import { draftClientChange } from '../lib/ai.js'
import { isPaymentRequired } from '../lib/billing.js'
import Attachments from '../components/Attachments.jsx'
import {
  clientFormChecks, clientProgress, uploadToMessage, kindOf, tooBig, mediaLimits, fmtBytes
} from '../lib/media.js'
// The sheets here are opened through `openSheet` and never see the router's hook, which is
// exactly what lib/nav.js exists for. Aliased so it cannot be confused with the `nav` the
// view component below gets from `useNavigate`.
import { nav as goTo } from '../lib/nav.js'

const exLabel = id => exName(EXIDX[id]) || id

/* A routine's exercise list, rendered the same way in the read view and in the proposal
 * preview — so what a coach sends is visibly the thing they were just looking at. */
function ExerciseList({ exercises }) {
  if (!exercises?.length) return <p className="dim small">{t('No exercises yet')}</p>
  return (
    <ol className="dim small" style={{ margin: '4px 0 0', paddingLeft: 20, lineHeight: 1.7 }}>
      {exercises.map((e, i) => (
        <li key={`${e.id}-${i}`}>
          {exLabel(e.id)}
          {e.sets ? ` — ${e.sets} × ${modeOf(e) === 'time' ? `${e.sec || 30}s` : (e.reps ?? '?')}` : ''}
        </li>
      ))}
    </ol>
  )
}

function ProposeSheet({ clientId, routine, close, onDone, draft = null }) {
  const toast = useUI(s => s.toast)
  const [name, setName] = useState(draft?.payload?.name ?? routine.name)
  const [note, setNote] = useState(draft?.note ?? '')
  const [rows, setRows] = useState(() =>
    (draft?.payload?.exercises ?? routine.exercises ?? []).map(e => ({ ...e })))
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
    } catch (e) {
      // Refused for want of payment: the draft is fine, the subscription is not. Send them to
      // the screen that fixes it rather than making them read an error and guess.
      if (isPaymentRequired(e)) { close(); goTo('/billing') }
      else setErr(e.message)
    }
    finally { setBusy(false) }
  }

  return (
    <div className="sheet-body">
      <h2>{t('Propose a change')}</h2>
      <p className="dim small">
        {t('Nothing changes on their side until they accept. Their own edits stay as they are in the meantime.')}
      </p>

      {draft && (
        <div className="card small" style={{ borderLeft: '3px solid var(--acc)' }}>
          <strong>{say(draft.headline)}</strong>
          <div className="dim" style={{ marginTop: 4 }}>
            {(draft.changes || []).map((c, i) => (
              <div key={i}>{c.name}: {c.field} {c.from ?? '—'} → {c.to}</div>
            ))}
          </div>
          <div className="dim" style={{ marginTop: 6 }}>
            {draft.source === 'model'
              ? t('Drafted from their logged sets; wording from a language model. Edit anything before you send it.')
              : t('Drafted from their logged sets. Edit anything before you send it.')}
          </div>
        </div>
      )}

      <TextField value={name} onChange={e => setName(e.target.value)} placeholder={t('Routine name')} />

      <Section title={t('Exercises')}>
        {rows.map((r, i) => (
          <Row key={`${r.id}-${i}`} title={exLabel(r.id)}>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input className="input" style={{ width: 54, textAlign: 'center', padding: '8px 4px' }}
                     inputMode="numeric" value={r.sets ?? ''} aria-label={t('Sets')}
                     onChange={e => patch(i, 'sets', Number(e.target.value) || 0)} />
              <span className="dim">×</span>
              <input className="input" style={{ width: 54, textAlign: 'center', padding: '8px 4px' }}
                     inputMode="numeric"
                     value={(r.mode === 'time' ? r.sec : r.reps) ?? ''}
                     aria-label={r.mode === 'time' ? t('Seconds') : t('Reps')}
                     onChange={e => patch(i, r.mode === 'time' ? 'sec' : 'reps', Number(e.target.value) || 0)} />
              <button className="iconbtn" aria-label={t('Remove')} onClick={() => remove(i)}>
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

/* What the client filmed of this session, read-only.
 *
 * A coach never uploads into a client's account — the same rule that puts a proposed programme
 * in `routine_revisions` rather than writing their routine — so there is no picker here and no
 * delete. A coach who wants to send a video back puts it on a message, which is theirs.
 *
 * A refusal is not an error to report: it means the client shared this session's numbers and
 * not its footage, and a coach does not need a red sentence to be told about a boundary
 * somebody drew on purpose.
 */
function SessionVideos({ clientId, workoutId }) {
  const [files, setFiles] = useState(null)

  useEffect(() => {
    clientFormChecks(clientId, workoutId).then(setFiles).catch(() => setFiles([]))
  }, [clientId, workoutId])

  if (!files?.length) return null
  return (
    <>
      <h4 className="sec">{t('Form checks')}</h4>
      <Attachments subject="form_check" files={files} readOnly onChange={() => {}} />
    </>
  )
}

function MessageSheet({ linkId, clientId, context, close }) {
  const toast = useUI(s => s.toast)
  const [messages, setMessages] = useState(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(null)     // picked, not yet sent
  const [progress, setProgress] = useState(null)
  const fileInput = useRef(null)

  const load = async () => { try { setMessages((await fetchThread(linkId)).messages) } catch { setMessages([]) } }
  useEffect(() => { load() }, [linkId])

  const pick = e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const kind = kindOf(f)
    if (!kind) return toast(t('That kind of file cannot be attached here.'))
    if (tooBig(f)) return toast(t('That file is too large — the limit is {0}.', fmtBytes(mediaLimits()[kind])))
    setPending(f)
  }

  /* The message first, then the file.
   *
   * An attachment row has to point at a message that exists, so the order is forced — and it is
   * the right way round anyway: a failed upload leaves a message that was said, where the other
   * order would risk a file with nothing to hang it on. The text is cleared as soon as the
   * message is away, so retrying the upload can never send a second one.
   */
  const send = async () => {
    const text = body.trim()
    if (!text) return
    setBusy(true)
    try {
      const { message } = await sendMessage(linkId, text, context)
      setBody('')
      if (pending) {
        setProgress(0)
        try { await uploadToMessage({ messageId: message.id, file: pending, onProgress: setProgress }) }
        catch (e) { toast(e.message || t('Upload failed.')) }
        finally { setProgress(null); setPending(null) }
      }
      await load()
      toast(t('Sent'))
    } catch (e) {
      if (isPaymentRequired(e)) { toast(t('Renew your subscription to message clients')); goTo('/billing') }
      else toast(e.message)
    }
    finally { setBusy(false) }
  }

  return (
    <div className="sheet-body">
      <h2>{context?.workoutId ? t('About this session') : t('Messages')}</h2>
      {clientId && context?.workoutId &&
        <SessionVideos clientId={clientId} workoutId={context.workoutId} />}
      <div style={{ maxHeight: '46vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages == null && <p className="dim small">{t('Loading…')}</p>}
        {messages?.length === 0 && <p className="dim small">{t('Nothing here yet.')}</p>}
        {messages?.map(m => (
          <div key={m.id} className="card small" style={{ margin: 0 }}>
            <strong>{m.sender_name}</strong>
            {m.workout_id && <span className="dim"> · {t('on a session')}</span>}
            <div>{m.body}</div>
            {m.attachments?.length > 0 &&
              <Attachments subject="message" files={m.attachments} readOnly onChange={() => {}} />}
          </div>
        ))}
      </div>
      <TextArea rows={3} value={body} onChange={e => setBody(e.target.value)}
                placeholder={t('Write a message')} />
      <input ref={fileInput} type="file" accept="image/*,video/*,audio/*" hidden onChange={pick} />
      {progress === null
        ? <Button icon="plus" onClick={() => fileInput.current?.click()}>
            {pending ? t('Attached: {0}', fmtBytes(pending.size)) : t('Attach a file')}
          </Button>
        : <div className="upl">
            <div className="upl-bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <span className="ss">{t('Uploading… {0}%', Math.round(progress * 100))}</span>
          </div>}
      <Button variant="primary" icon="upload" disabled={busy || !body.trim()} onClick={send}>
        {busy ? t('Sending…') : t('Send')}
      </Button>
      <Button onClick={close}>{t('Close')}</Button>
    </div>
  )
}

/* Progress photos, when the client has granted that scope specifically.
 *
 * Its own section rather than a row inside body weight, because it is its own decision. A coach
 * reading weigh-ins has been told a number; a coach reading these has been shown a body, and
 * folding the second permission into the first would be deciding that on the client's behalf.
 */
function ClientPhotos({ clientId }) {
  const [files, setFiles] = useState(null)

  useEffect(() => {
    clientProgress(clientId).then(setFiles).catch(() => setFiles([]))
  }, [clientId])

  return (
    <Section title={t('Progress photos')}>
      {files === null && <Row icon="person" title={t('Loading…')} />}
      {files?.length === 0 && <Row icon="person" title={t('No photos yet')} />}
      {files?.length > 0 &&
        <Attachments subject="progress" files={files} readOnly onChange={() => {}} />}
    </Section>
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
  const [drafting, setDrafting] = useState(false)
  const toast = useUI(s => s.toast)

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
  const openMessages = ctx => openSheet(close =>
    <MessageSheet linkId={link.id} clientId={id} context={ctx} close={close} />)

  /* Drafting never sends. It reads their logged sets, works out what to change, and opens the
   * same composer the coach uses by hand, filled in. The coach is the one who decides. */
  const draftChange = async () => {
    setDrafting(true)
    try {
      const draft = await draftClientChange(id)
      if (!draft.change) { toast(say(draft.detail) || t('Nothing to change')); return }
      const target = routines.find(r => r.id === draft.change.routineId) ||
                     { id: draft.change.routineId, name: draft.change.payload.name, exercises: [] }
      openSheet(close => (
        <ProposeSheet clientId={id} routine={target} close={close} onDone={load}
                      draft={{ ...draft.change, note: draft.note, headline: draft.headline, source: draft.source }} />
      ))
    } catch (e) { toast(e.message) }
    finally { setDrafting(false) }
  }

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
        {scopes.includes('workouts') && (
          <Row icon="sparkles" iconTint="var(--acc)"
               title={drafting ? t('Reading their last 4 weeks…') : t('Draft a change')}
               subtitle={t('Finds what has stalled or slipped and fills in a proposal for you to edit')}
               accessory="chevron"
               onClick={drafting ? undefined : draftChange} />
        )}
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

      {scopes.includes('photos') ? <ClientPhotos clientId={id} /> : <NotShared what="photos" />}

      <div style={{ height: 32 }} />
    </div>
  )
}
