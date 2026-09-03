import { create } from 'zustand'
import { uid } from '@gymyar/domain'
import { beep, vibrate } from '../lib/sound.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { useStore } from './useStore.js'
import { connectStrap as openStrap } from '../lib/heart-strap.js'

/* Fire-and-forget: lets the server push a "rest over" alert if this tab gets suspended
 * before the local timer completes. No-ops for guests / offline.
 *
 * The words go with the request. The server has no language for a user — nothing stores one,
 * and the locale packs are in this bundle — so the side that knows is the side that has to
 * say, or a Persian app buzzes in English. */
const pushRestTimer = sec => {
  if (!useStore.getState().user) return
  const body = JSON.stringify({ seconds: sec, title: t('Rest over'), body: t('Next set.') })
  api('/api/push/rest-timer', { method: 'POST', body }).catch(() => {})
}
const cancelPushRestTimer = () => { if (useStore.getState().user) api('/api/push/rest-timer/cancel', { method: 'POST', body: '{}' }).catch(() => {}) }

let toastTm = null
let timerInt = null
let timerTick = null
let workInt = null
let workTick = null
let workDone = null

/* The strap, and everything it has said.
 *
 * Both of these are module state rather than store state, for opposite reasons. The connection
 * is an object with methods and no rendered form — nothing subscribes to it and putting it in
 * a store would only invite somebody to. The samples are a growing array written roughly once
 * a second, and an hour of training is a few thousand of them; as store state every reading
 * would re-render every subscriber to hand them a list nothing draws. What screens actually
 * want is the latest number, and that is what `strap` below carries. */
let strapConn = null
let strapSamples = []

export const useUI = create((set, get) => ({
  sheets: [],          // { id, render:(close)=>JSX, kind:'sheet'|'center', locked }
  toastMsg: '',
  timer: null,         // rest countdown between sets — { left, total, endsAt }
  strap: null,         // a connected heart-rate strap — { name, bpm, at }
  work: null,          // work countdown DURING a timed set (issue #16) — { left, total, endsAt, label }

  openSheet(render, { kind = 'sheet', locked = false } = {}) {
    const id = uid()
    set(s => ({ sheets: [...s.sheets, { id, render, kind, locked }] }))
    const close = () => get().closeSheet(id)
    return { id, close, lock: v => set(s => ({ sheets: s.sheets.map(x => x.id === id ? { ...x, locked: v } : x) })) }
  },
  closeSheet(id) { set(s => ({ sheets: s.sheets.filter(x => x.id !== id) })) },
  closeAll() { set({ sheets: [] }) },

  toast(msg) {
    set({ toastMsg: msg })
    clearTimeout(toastTm)
    toastTm = setTimeout(() => set({ toastMsg: '' }), 2200)
  },

  startRest(sec) {
    get().stopRest()
    const endsAt = Date.now() + sec * 1000
    set({ timer: { left: sec, total: sec, endsAt } })
    pushRestTimer(sec)
    timerTick = () => {
      const tm = get().timer
      if (!tm) return
      const left = Math.max(0, Math.round((tm.endsAt - Date.now()) / 1000))
      if (left === tm.left) return
      const snd = useStore.getState().S.sound
      if (left <= 0) {
        beep(snd, 880, 0.15); beep(snd, 880, 0.15, 0.25); beep(snd, 1320, 0.4, 0.5)
        vibrate([200, 100, 200]); get().toast(t('Rest over — next set!')); get().stopRest(); return
      }
      if (left <= 3) beep(snd, 660, 0.1)
      set({ timer: { ...tm, left } })
    }
    timerInt = setInterval(timerTick, 1000)
    document.addEventListener('visibilitychange', timerTick)
  },
  addRest(sec) {
    const tm = get().timer
    if (!tm) return
    const left = tm.left + sec
    // taking off more than is left means "I'm ready now" — same as skipping, and it keeps a
    // negative duration out of both the progress bar and the server-side push schedule
    if (left <= 0) { get().stopRest(); return }
    set({ timer: { ...tm, left, total: tm.total + sec, endsAt: tm.endsAt + sec * 1000 } })
    pushRestTimer(left)
  },
  stopRest() {
    if (timerInt) clearInterval(timerInt); timerInt = null
    if (timerTick) document.removeEventListener('visibilitychange', timerTick); timerTick = null
    if (get().timer) cancelPushRestTimer()
    set({ timer: null })
  },

  /* ---- work timer (issue #16) ----
     Times the set itself, not the recovery after it. Kept separate from the rest timer on
     purpose: the two mean opposite things, they must never run together, and a work set is
     something you are watching — so it gets no server push (that endpoint says "rest over",
     and a plank does not need a notification you are staring at anyway).
     `onDone(elapsedSec)` is called both when the countdown reaches zero and on an early
     finish; the elapsed time is what actually gets logged, so stopping at 0:38 of a 0:45
     hold records 0:38 rather than crediting the full target. */
  startWork(sec, label, onDone) {
    get().stopWork()
    get().stopRest()
    const total = Math.max(1, Math.round(sec) || 1)
    const endsAt = Date.now() + total * 1000
    workDone = onDone
    set({ work: { left: total, total, endsAt, label } })
    workTick = () => {
      const wk = get().work
      if (!wk) return
      const left = Math.max(0, Math.round((wk.endsAt - Date.now()) / 1000))
      if (left === wk.left) return
      const snd = useStore.getState().S.sound
      if (left <= 0) {
        beep(snd, 880, 0.15); beep(snd, 880, 0.15, 0.25); beep(snd, 1320, 0.4, 0.5)
        vibrate([200, 100, 200])
        const done = workDone
        get().stopWork()
        if (done) done(wk.total)
        return
      }
      if (left <= 3) beep(snd, 660, 0.1)
      set({ work: { ...wk, left } })
    }
    workInt = setInterval(workTick, 1000)
    document.addEventListener('visibilitychange', workTick)
  },
  // Ended the hold early — log what was actually held.
  finishWorkEarly() {
    const wk = get().work
    if (!wk) return
    const elapsed = Math.max(1, wk.total - wk.left)
    const done = workDone
    vibrate(30)
    get().stopWork()
    if (done) done(elapsed)
  },
  // Abandon without logging anything.
  stopWork() {
    if (workInt) clearInterval(workInt); workInt = null
    if (workTick) document.removeEventListener('visibilitychange', workTick); workTick = null
    workDone = null
    set({ work: null })
  },

  /* ---------------------------------------------------------- heart rate ---- */

  /* Ask for a strap and start listening. Must be called from a tap: both transports put a
   * chooser on screen and neither platform will open one that was not asked for. Throws what
   * the platform threw — including the user simply cancelling the chooser, which is not an
   * error worth a toast and is why the caller decides. */
  async connectStrap() {
    if (strapConn) return
    const conn = await openStrap(
      bpm => {
        strapSamples.push({ t: Date.now(), bpm })
        set(s => (s.strap ? { strap: { ...s.strap, bpm, at: Date.now() } } : {}))
      },
      () => {
        // Out of range, or the battery went. Distinct from a disconnect we asked for, which
        // never reaches here — see the transport.
        strapConn = null
        set({ strap: null })
        vibrate(30)
        get().toast(t('Heart-rate strap disconnected'))
      })
    strapConn = conn
    set({ strap: { name: conn.name, bpm: null, at: 0 } })
  },

  async disconnectStrap() {
    const conn = strapConn
    strapConn = null
    set({ strap: null })
    if (conn) await conn.disconnect()
  },

  /* Every reading since the strap was connected, and forget them.
   *
   * Drained rather than read, because the caller is the end of a workout: leaving them here
   * would put the last session's heart rate on the next one, and the samples are of no use to
   * anything once they have been summarised into the four numbers a workout stores. */
  takeStrapSamples() {
    const all = strapSamples
    strapSamples = []
    return all
  }
}))
