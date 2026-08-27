import { useEffect, useRef } from 'react'
import { fmtVol, fmtDur, isoOf, todayISO, startOfWeek, weekdayLabels, dateParts, monthLabel } from '@gymyar/domain'
import { t } from '../lib/i18n.js'

/* Every other row is labelled and the rest are spacers, as before. Which weekday each row *is*
 * depends on where the week starts, though, so the labels come off the same rotation the grid
 * is built from rather than being written down as Mon/Wed/Fri — those were the first, third and
 * fifth rows only because the week began on Monday. */
const LABELLED_ROWS = new Set([0, 2, 4])

// GitHub-style activity heatmap, shaded by time trained per day.
export default function Heatmap({ S, onDay }) {
  const wrapRef = useRef(null)
  useEffect(() => { if (wrapRef.current) wrapRef.current.scrollLeft = wrapRef.current.scrollWidth }, [])

  const agg = {}
  S.workouts.forEach(w => {
    const a = agg[w.d] = agg[w.d] || { n: 0, vol: 0, min: 0 }
    a.n++; a.vol += w.vol || 0
    a.min += Math.max(0, Math.round(((w.end || w.start) - w.start) / 60000))
  })
  const mins = Object.values(agg).map(a => a.min).filter(v => v > 0).sort((a, b) => a - b)
  const q = p => (mins.length ? mins[Math.min(mins.length - 1, Math.floor(p * mins.length))] : 0)
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75)
  const level = a => !a ? 0 : !a.min ? 1 : a.min >= t3 ? 4 : a.min >= t2 ? 3 : a.min >= t1 ? 2 : 1

  const today = new Date(); today.setHours(12, 0, 0, 0)
  const end = startOfWeek(today)
  const start = new Date(end); start.setDate(end.getDate() - 52 * 7)

  const months = [], cols = []
  let lastMonth = -1
  for (let wk = 0; wk <= 52; wk++) {
    const colStart = new Date(start); colStart.setDate(start.getDate() + wk * 7)
    // Both the month a column belongs to and the test for "this column opens a month" are read
    // in the locale's calendar. `day <= 7` says the same thing the old `getDate() <= 7` did,
    // only about Shahrivar rather than about August.
    const { month: mo, day } = dateParts(colStart)
    const opensMonth = day <= 7
    const showM = mo !== lastMonth && opensMonth && wk < 51
    months.push(<span key={wk}>{showM ? monthLabel(colStart, { long: false }) : ''}</span>)
    if (opensMonth) lastMonth = mo
    const cells = []
    for (let d = 0; d < 7; d++) {
      const day = new Date(colStart); day.setDate(colStart.getDate() + d)
      const key = isoOf(day)
      const a = agg[key]
      const cls = 'hm-c l' + level(a) + (key === todayISO() ? ' today' : '') + (day > today ? ' future' : '')
      cells.push(<div key={d} className={cls}
        title={key + (a ? ` · ${t(a.n === 1 ? '{0} workout' : '{0} workouts', a.n)} · ${fmtDur(a.min * 60000)} · ${fmtVol(a.vol, S.unit)}` : '')}
        onClick={a ? () => onDay(key) : undefined} />)
    }
    cols.push(<div key={wk} className="hm-col">{cells}</div>)
  }

  return <>
    <div className="hm-wrap" ref={wrapRef}>
      <div className="hm-months" style={{ marginLeft: 30 }}>{months}</div>
      <div className="hm-body">
        <div className="hm-days">{weekdayLabels().map((lbl, i) =>
          <span key={i}>{LABELLED_ROWS.has(i) ? t(lbl) : ''}</span>)}</div>
        <div className="hm-grid">{cols}</div>
      </div>
    </div>
    <div className="hm-legend">{t('Less time')} <div className="hm-c l0" /><div className="hm-c l1" /><div className="hm-c l2" /><div className="hm-c l3" /><div className="hm-c l4" /> {t('More time')}</div>
  </>
}
