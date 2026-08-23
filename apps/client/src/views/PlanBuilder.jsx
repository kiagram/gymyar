/* Build me a plan.
 *
 * Two ways in, because people arrive in two states: some know exactly what they want and will
 * tick boxes, and some can only say "I want to get stronger, I've got dumbbells at home". Both
 * end at the same place — a plan on screen, with every lift named, that does nothing until the
 * person says so.
 *
 * The review side of the same screen is the other half: what a coach would notice reading your
 * last month, for people who do not have one.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { Section, Row, Button, TextArea, Check, Segmented } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { glyphOf } from '../lib/glyphs.js'
import { t, say } from '../lib/i18n.js'
import { DAYN, uid } from '@gymbuddy/domain'
import {
  aiStatus, draftProgramme, reviewMe,
  GOAL_OPTIONS, EXPERIENCE_OPTIONS, EQUIPMENT_OPTIONS
} from '../lib/ai.js'

const SEVERITY = { high: 'var(--red)', medium: 'var(--orange)', low: 'var(--label-3)' }

/* ------------------------------------------------------------- the plan ---- */

function PlanPreview({ plan, onApply, onBack, busy }) {
  const S = useStore(s => s.S)
  const replacing = (S.routines || []).length > 0

  return (
    <>
      <Section title={t('Your plan')}
               footer={plan.notes?.length ? plan.notes.join(' ') : undefined}>
        {plan.routines.map(r => (
          <Row key={r.id} icon={glyphOf(r.emoji)} title={r.name}
               subtitle={r.ex.map(e => e.name).join(' · ')}
               value={`${r.ex.length}`} />
        ))}
      </Section>

      <Section title={t('Week')}>
        {[1, 2, 3, 4, 5, 6, 0].map(d => {
          const r = plan.routines.find(x => x.id === plan.week[d])
          return <Row key={d} title={t(DAYN[d])} value={r ? r.name : t('Rest')}
                      className={r ? '' : 'dim'} />
        })}
      </Section>

      <Section title={t('Sets and reps')}
               footer={t('Weights are not set here — the app works them out from what you lift in your first session, and then progresses them.')}>
        {plan.routines.map(r => (
          <Row key={`d-${r.id}`} title={r.name}
               subtitle={r.ex.map(e => `${e.name} ${e.sets}×${e.mode === 'time' ? `${e.sec}s` : e.reps}`).join(' · ')} />
        ))}
      </Section>

      {replacing && (
        <p className="dim small" style={{ textAlign: 'center' }}>
          {t('You already have {0} routines. This adds to them rather than replacing anything.',
             (S.routines || []).length)}
        </p>
      )}

      <Button variant="primary" icon="check" disabled={busy} onClick={onApply}>
        {busy ? t('Adding…') : t('Add this to my plan')}
      </Button>
      <Button onClick={onBack}>{t('Start over')}</Button>
      <div style={{ height: 32 }} />
    </>
  )
}

/* ---------------------------------------------------------------- form ---- */

function BuilderForm({ onDraft, busy, error, status }) {
  const [mode, setMode] = useState('describe')
  const [text, setText] = useState('')
  const [goal, setGoal] = useState('strength')
  const [experience, setExperience] = useState('returning')
  const [days, setDays] = useState(3)
  const [minutes, setMinutes] = useState(60)
  const [equipment, setEquipment] = useState(['body weight', 'dumbbell'])

  const toggle = value =>
    setEquipment(cur => (cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value]))

  const submit = () => onDraft(mode === 'describe'
    ? { text: text.trim() }
    : { brief: { goal, experience, daysPerWeek: days, sessionMinutes: minutes, equipment } })

  return (
    <>
      <Segmented
        className="seg-full"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'describe', label: t('Describe it') },
          { value: 'choose', label: t('Choose') }
        ]}
      />

      {mode === 'describe' ? (
        <>
          <TextArea rows={4} value={text} onChange={e => setText(e.target.value)}
                    placeholder={t('e.g. I want to get stronger, I can train 4 days a week for about an hour, and I have a barbell and dumbbells at home')} />
          <p className="dim small">
            {status?.model
              ? t('What you write is read for your goal, your days and your equipment. The plan itself is built from your answers and the exercise library — nothing is invented.')
              : t('No language model is configured, so this reads your text for the usual words — goal, days a week, equipment. The plan is built the same way either way.')}
          </p>
        </>
      ) : (
        <>
          <Section title={t('What are you after?')}>
            {GOAL_OPTIONS.map(o => (
              <Row key={o.value} title={t(o.label)} subtitle={t(o.detail)}
                   accessory={goal === o.value ? 'check' : 'none'}
                   onClick={() => setGoal(o.value)} />
            ))}
          </Section>

          <Section title={t('Where are you starting?')}>
            {EXPERIENCE_OPTIONS.map(o => (
              <Row key={o.value} title={t(o.label)} subtitle={t(o.detail)}
                   accessory={experience === o.value ? 'check' : 'none'}
                   onClick={() => setExperience(o.value)} />
            ))}
          </Section>

          <Section title={t('How often, and how long?')}>
            <Row title={t('Days a week')}>
              <Segmented value={days} onChange={setDays}
                         options={[2, 3, 4, 5, 6].map(n => ({ value: n, label: String(n) }))} />
            </Row>
            <Row title={t('Minutes a session')}>
              <Segmented value={minutes} onChange={setMinutes}
                         options={[30, 45, 60, 90].map(n => ({ value: n, label: String(n) }))} />
            </Row>
          </Section>

          <Section title={t('What can you use?')}
                   footer={t('Only what you actually have. A plan built around a rack you cannot reach is worse than one built around dumbbells you can.')}>
            {EQUIPMENT_OPTIONS.map(o => (
              <Row key={o.value} title={t(o.label)} onClick={() => toggle(o.value)}>
                <Check checked={equipment.includes(o.value)} onChange={() => toggle(o.value)} />
              </Row>
            ))}
          </Section>
        </>
      )}

      {error && <p className="err small">{error}</p>}
      <Button variant="primary" icon="sparkles" disabled={busy || (mode === 'describe' && !text.trim())}
              onClick={submit}>
        {busy ? t('Building…') : t('Build me a plan')}
      </Button>
      <div style={{ height: 32 }} />
    </>
  )
}

/* -------------------------------------------------------------- review ---- */

function Review() {
  const [review, setReview] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => { reviewMe(28).then(setReview).catch(e => setErr(e.message)) }, [])

  if (err) return <p className="err small">{err}</p>
  if (!review) return <p className="dim small">{t('Reading your last month…')}</p>

  if (!review.findings.length) {
    return (
      <Section title={t('Your last 4 weeks')}>
        <Row icon="checkCircle" iconTint="var(--green)"
             title={review.sessions ? t('{0} sessions, nothing to flag', review.sessions) : t('Nothing logged yet')}
             subtitle={review.sessions
               ? t('Everything is progressing or holding. Leaving a programme alone while it works is a decision too.')
               : t('Log a few sessions and this will have something to say.')} />
      </Section>
    )
  }

  return (
    <Section title={t('Your last 4 weeks')}
             footer={t('All of this comes from sets you logged — not from how anything felt.')}>
      {review.findings.map((f, i) => (
        <Row key={`${f.kind}-${i}`}
             icon={f.severity === 'high' ? 'flame' : f.severity === 'medium' ? 'info' : 'dot'}
             iconTint={SEVERITY[f.severity]}
             title={say(f.title)} subtitle={say(f.detail)} />
      ))}
    </Section>
  )
}

/* --------------------------------------------------------------- screen ---- */

export default function PlanBuilder() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const update = useStore(s => s.update)
  const syncNow = useStore(s => s.syncNow)

  const [tab, setTab] = useState('build')
  const [status, setStatus] = useState(null)
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => { aiStatus().then(setStatus).catch(() => setStatus({ model: false })) }, [])

  const draft = async input => {
    setBusy(true); setError(null)
    try { setPlan(await draftProgramme(input)) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const apply = async () => {
    setBusy(true)
    try {
      // Fresh ids on the way in. The ids the server generated are for its draft; reusing them
      // would collide the moment somebody builds two plans, and these rows belong to this
      // person the instant they land.
      const idMap = {}
      const routines = plan.routines.map(r => {
        const id = uid()
        idMap[r.id] = id
        return {
          id, name: r.name, emoji: r.emoji, policy: r.policy,
          ex: r.ex.map(({ name, ...cfg }) => cfg)
        }
      })
      update(s => {
        s.routines.push(...routines)
        for (const [day, routineId] of Object.entries(plan.week)) {
          if (idMap[routineId]) s.week[day] = idMap[routineId]
        }
      })
      await syncNow()
      toast(t('Added to your plan'))
      nav('/plan')
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="view">
      <header className="vhead">
        <button className="back" onClick={() => nav('/plan')}><Icon name="chevronLeft" /></button>
        <div>
          <h1>{t('Build a plan')}</h1>
          <div className="sub">
            {status && !status.model
              ? t('Built from your answers and the exercise library')
              : t('Built from your answers, your history and the exercise library')}
          </div>
        </div>
      </header>

      {!plan && (
        <Segmented
          className="seg-full"
          value={tab} onChange={setTab}
          options={[
            { value: 'build', label: t('New plan') },
            { value: 'review', label: t('Review my training') }
          ]}
        />
      )}

      {plan
        ? <PlanPreview plan={plan} busy={busy} onApply={apply} onBack={() => setPlan(null)} />
        : tab === 'build'
          ? <BuilderForm onDraft={draft} busy={busy} error={error} status={status} />
          : <><Review /><div style={{ height: 32 }} /></>}
    </div>
  )
}
