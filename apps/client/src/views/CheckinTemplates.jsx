import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUI } from '../store/useUI.js'
import { FIELD_TYPES, MAX_FIELDS, normaliseFields, fmtInt } from '@gymyar/domain'
import { fetchTemplates, saveTemplate, archiveTemplate } from '../lib/coaching.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import { Button, Section, Row, TextField, Switch, Segmented, NumberField } from '../components/ui.jsx'

/* The questions a coach asks, and the screen for writing them.
 *
 * A template is the one thing on the coaching side that is purely the coach's own — no scope
 * gates it, no client sees it until it is put on them. So this is a plain editor with no
 * permission ceremony in it, and the only rules are the ones about what makes an answerable
 * question: every field needs a key, a scale is always one to five, and a form has a length
 * past which nobody fills it in.
 *
 * Fields go through `normaliseFields` before saving here as well as on the server. Not because
 * the server is untrusted from this side, but because a coach should see what they are about to
 * save — a field they left half-written disappearing on save is confusing, and seeing it
 * disappear as they edit is not.
 */

/** A key a coach never types: derived from the label, which is the thing they do type. */
const keyFrom = (label, taken) => {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
  // A Persian label leaves nothing behind, which is most of them here — so fall back to a
  // positional key rather than refusing the field. It is an identifier, not a name; the label
  // is the name and it is kept exactly as written.
  const stem = /^[a-z]/.test(base) ? base : 'q'
  let key = stem
  let n = 2
  while (taken.has(key)) key = `${stem}_${n++}`
  return key
}

const TYPE_LABEL = {
  scale: 'Scale of 1–5',
  text: 'Free text',
  bodyweight: 'Body weight',
  measure: 'A measurement',
  bool: 'Yes or no',
  photo: 'Ask for a photo'
}

function FieldEditor({ field, onChange, onRemove }) {
  const set = patch => onChange({ ...field, ...patch })

  return (
    <div className="card" style={{ padding: 12, marginBottom: 8 }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <TextField
          value={field.label}
          onChange={e => set({ label: e.target.value })}
          maxLength={80}
          placeholder={t('The question')}
          style={{ flex: 1 }} />
        <button className="iconbtn" onClick={onRemove} aria-label={t('Remove')}
          style={{ color: 'var(--red)' }}><Icon name="trash" /></button>
      </div>

      <Segmented
        value={field.type}
        onChange={type => set({ type })}
        options={FIELD_TYPES.map(v => ({ value: v, label: t(TYPE_LABEL[v]) }))} />

      {field.type === 'measure' && (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <NumberField value={field.min ?? ''} onChange={min => set({ min })} placeholder={t('Least')} />
          <NumberField value={field.max ?? ''} onChange={max => set({ max })} placeholder={t('Most')} />
          <TextField value={field.unit ?? ''} onChange={e => set({ unit: e.target.value })}
            maxLength={12} placeholder={t('Unit')} style={{ width: 80 }} />
        </div>
      )}

      {field.type !== 'photo' && (
        <div className="row between" style={{ marginTop: 10 }}>
          <span className="small muted">{t('Must be answered')}</span>
          <Switch checked={!!field.required} onChange={required => set({ required })} />
        </div>
      )}
    </div>
  )
}

function Editor({ template, onSaved, onCancel }) {
  const toast = useUI(s => s.toast)
  const [title, setTitle] = useState(template?.title ?? '')
  const [fields, setFields] = useState(template?.fields ?? [])
  const [busy, setBusy] = useState(false)

  const add = () => {
    if (fields.length >= MAX_FIELDS) { toast(t('That is as long as a weekly form should get')); return }
    setFields(f => [...f, { key: '', type: 'scale', label: '' }])
  }

  const save = async () => {
    // Keys are assigned at save time from the labels, because a label is edited until the last
    // moment and a key that chased it would rename itself under answers already given.
    const taken = new Set()
    const keyed = fields.map(f => {
      const key = f.key || keyFrom(f.label, taken)
      taken.add(key)
      return { ...f, key }
    })
    const clean = normaliseFields(keyed)
    if (!clean.length) { toast(t('Add at least one question')); return }

    setBusy(true)
    try {
      const r = await saveTemplate({ id: template?.id, title, fields: clean })
      onSaved(r.template)
    } catch (e) {
      toast(e.message)
    } finally { setBusy(false) }
  }

  return (
    <>
      <Section title={t('Name')}>
        <div style={{ padding: '4px 14px 12px' }}>
          <TextField value={title} onChange={e => setTitle(e.target.value)} maxLength={120}
            placeholder={t('Weekly check-in')} />
        </div>
      </Section>

      <h4 className="sec">{t('Questions')}</h4>
      {fields.map((f, i) => (
        <FieldEditor key={i} field={f}
          onChange={next => setFields(list => list.map((x, j) => (j === i ? next : x)))}
          onRemove={() => setFields(list => list.filter((_, j) => j !== i))} />
      ))}

      <Button icon="plus" onClick={add}>{t('Add a question')}</Button>
      <p className="sect-f">
        {t('Up to {0} questions. Short forms get answered; long ones get answered twice.',
          fmtInt(MAX_FIELDS))}
      </p>

      <div style={{ height: 8 }} />
      <Button variant="primary" onClick={save} disabled={busy}>
        {busy ? t('Saving…') : t('Save')}
      </Button>
      <div style={{ height: 8 }} />
      <Button variant="ghost" className="dim" onClick={onCancel}>{t('Cancel')}</Button>
    </>
  )
}

export default function CheckinTemplates() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const [templates, setTemplates] = useState(null)
  const [editing, setEditing] = useState(null)   // a template, {} for a new one, or null

  const load = () => fetchTemplates().then(r => setTemplates(r.templates)).catch(() => setTemplates([]))
  useEffect(() => { load() }, [])

  const retire = async tpl => {
    await archiveTemplate(tpl.id)
    toast(t('Archived — answers already given keep their questions'))
    load()
  }

  return (
    <div className="narrow">
      <div className="hdr">
        <div>
          <h1>{t('Check-ins')}</h1>
          <div className="sub">{t('The questions you ask, week to week')}</div>
        </div>
        <button className="iconbtn" onClick={() => nav('/coach')} aria-label={t('Back')}>
          <Icon name="chevronLeft" />
        </button>
      </div>

      {editing ? (
        <Editor
          template={editing.id ? editing : null}
          onSaved={() => { setEditing(null); load(); toast(t('Saved')) }}
          onCancel={() => setEditing(null)} />
      ) : (
        <>
          <Section>
            {templates === null && <Row icon="clipboard" title={t('Loading…')} />}
            {templates?.length === 0 && (
              <Row icon="clipboard" title={t('No check-in yet')}
                subtitle={t('Write the questions once, then put them on whichever clients they suit.')} />
            )}
            {templates?.map(tpl => (
              <Row key={tpl.id} icon="clipboard" title={tpl.title}
                subtitle={t('{0} questions', fmtInt(tpl.fields.length))}
                accessory="chevron"
                onClick={() => setEditing(tpl)} />
            ))}
          </Section>

          <Button icon="plus" onClick={() => setEditing({})}>{t('New check-in')}</Button>

          {templates?.length > 0 && (
            <>
              <h4 className="sec">{t('Retire one')}</h4>
              {templates.map(tpl => (
                <Row key={tpl.id} icon="folder" title={tpl.title}
                  value={t('Archive')} onClick={() => retire(tpl)} />
              ))}
              <p className="sect-f">
                {t('Archiving stops it being asked. Every answer already given keeps the questions it answered.')}
              </p>
            </>
          )}
        </>
      )}

      <div style={{ height: 32 }} />
    </div>
  )
}
