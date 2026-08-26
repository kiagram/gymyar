/* Files attached to something — a set, a day, a message — in the one component that renders
 * them all.
 *
 * ## Why one component rather than three
 *
 * A form check, a progress photo and a voice note are the same four problems every time: pick
 * a file, watch it upload, play it back, delete it. The only thing that differs is which
 * endpoint it goes to and which kinds are allowed, and both of those are arguments. Three
 * copies would be three places to forget the progress indicator, three places to forget that
 * a signed URL expires, and eventually three screens that behave differently for no reason a
 * user could name.
 *
 * ## The list belongs to the screen, not to this
 *
 * The caller owns `files` and is handed a new array on every change. That is not ceremony: a
 * session's form checks are one request for the whole session, and a component that loaded its
 * own list would turn a five-exercise workout into five identical requests for slices of the
 * same answer. The screen asks once and slices it.
 *
 * ## Signed URLs expire, so nothing here caches one
 *
 * Every URL these rows carry stops working within minutes — see `packages/storage/src/sign.js`.
 * That is why the screen fetches when it opens rather than lifting the list into a store, and
 * why a freshly uploaded row is used as it is returned rather than re-derived later. A URL kept
 * anywhere that outlives the screen is a link that works while you are building it and is dead
 * by the time somebody scrolls back.
 *
 * ## An attachment whose bytes are missing
 *
 * The row and the bytes are in two systems and a restore can bring them back out of step, so
 * `<img>` and `<video>` failing is a state this renders rather than an impossibility. It says
 * the file is unavailable and leaves everything around it alone, which is the promise
 * docs/SELF_HOSTING.md makes about restoring a database next to an older media archive.
 */
import { useRef, useState } from 'react'
import { t } from '../lib/i18n.js'
import { kindOf, tooBig, mediaLimits, fmtBytes, deleteAttachment } from '../lib/media.js'
import { useUI } from '../store/useUI.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

/* What the file picker offers, per subject. `capture` asks a phone for the camera rather than
 * the gallery; a desktop browser ignores it, and both are fine — somebody filming a lift wants
 * the camera and somebody adding an old photo wants the roll, so the attribute is a hint here
 * rather than a restriction. */
const ACCEPT = {
  form_check: 'video/*,image/*',
  progress: 'image/*',
  message: 'image/*,video/*,audio/*'
}

/** One rendered file. Playback is the browser's job; this decides which element it gets. */
function Attachment({ file, onDelete, canDelete }) {
  const [broken, setBroken] = useState(false)

  if (broken) {
    return <div className="att att-gone">
      <Icon name="info" />
      <span className="ss">{t('This file is no longer available.')}</span>
    </div>
  }

  return <figure className="att">
    {file.kind === 'photo' &&
      <img src={file.url} alt={file.caption || t('Attachment')} loading="lazy"
        onError={() => setBroken(true)} />}
    {file.kind === 'video' &&
      /* `preload="metadata"` so a list of clips costs a few kilobytes rather than all of them:
       * the poster frame and the duration arrive, the video itself waits to be asked for. */
      <video src={file.url} controls playsInline preload="metadata"
        onError={() => setBroken(true)} />}
    {file.kind === 'audio' &&
      <audio src={file.url} controls preload="metadata" onError={() => setBroken(true)} />}

    <figcaption className="row between">
      <span className="ss grow">{file.caption || fmtBytes(file.bytes)}</span>
      {canDelete && <button className="iconbtn" aria-label={t('Delete')} onClick={onDelete}>
        <Icon name="trash" />
      </button>}
    </figcaption>
  </figure>
}

/**
 * @param subject   'form_check' | 'progress' | 'message' — decides what the picker offers
 * @param files     the rows to render; owned by the caller
 * @param onChange  (nextFiles) => void, after an upload or a delete
 * @param send      (file, onProgress) => Promise<row>, the upload for this subject
 * @param readOnly  a coach looking at somebody else's; no picker, no delete
 * @param addLabel  what the button says — "add a video" and "add a photo" are not the same
 * @param empty     what to say when there is nothing, in the words of the screen it is on
 */
export default function Attachments({
  subject, files, onChange, send, readOnly = false, addLabel, empty = null
}) {
  const [progress, setProgress] = useState(null)    // 0…1 while a file is going up
  const [error, setError] = useState(null)
  const input = useRef(null)
  const toast = useUI(s => s.toast)

  async function pick(e) {
    const file = e.target.files?.[0]
    e.target.value = ''                             // so picking the same file twice still fires
    if (!file) return
    setError(null)

    const kind = kindOf(file)
    if (!kind) return setError(t('That kind of file cannot be attached here.'))
    if (tooBig(file)) {
      return setError(t('That file is too large — the limit is {0}.', fmtBytes(mediaLimits()[kind])))
    }

    setProgress(0)
    try {
      const row = await send(file, setProgress)
      // Used as returned rather than re-fetched: the URL on it is fresh and one request is
      // enough. A list that re-asked the server here would be asking it what it just said.
      onChange([...files, row])
    } catch (err) {
      if (!err.cancelled) setError(err.message || t('Upload failed.'))
    } finally {
      setProgress(null)
    }
  }

  const remove = file => confirmSheet({
    title: t('Delete this file?'),
    message: t('It is removed for good, including for anyone you shared it with.'),
    confirmText: t('Delete'),
    danger: true,
    onConfirm: async () => {
      // Off the screen first, then the request. It is the owner's own row and the server has
      // already agreed once; making somebody watch a spinner to see their own file disappear is
      // the wrong trade. A failure puts it back and says so.
      onChange(files.filter(f => f.id !== file.id))
      try { await deleteAttachment(file.id); toast(t('Deleted')) }
      catch { onChange(files); toast(t('Could not delete that — try again.')) }
    }
  })

  return <div className="atts">
    {files.map(f => (
      <Attachment key={f.id} file={f} canDelete={!readOnly} onDelete={() => remove(f)} />
    ))}

    {!files.length && (empty || readOnly) &&
      <div className="ss dim">{readOnly ? t('Nothing here yet.') : empty}</div>}

    {!readOnly && <>
      <input ref={input} type="file" accept={ACCEPT[subject]} capture="environment"
        hidden onChange={pick} />
      {progress === null
        ? <Button icon="plus" onClick={() => input.current?.click()}>{addLabel}</Button>
        : <div className="upl">
          <div className="upl-bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <span className="ss">{t('Uploading… {0}%', Math.round(progress * 100))}</span>
        </div>}
      {error && <div className="ss err">{error}</div>}
    </>}
  </div>
}
