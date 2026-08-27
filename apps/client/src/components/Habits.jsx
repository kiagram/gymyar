import { useStore } from '../store/useStore.js'
import { todayISO, weekProgress, datesFor, habitStreakWeeks, currentRunDays, fmtInt } from '@gymyar/domain'
import { activeHabits, toggledTicks, isTickedOn } from '../lib/habits.js'
import { habitSheet, newHabitSheet } from '../sheets.jsx'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Check } from './ui.jsx'

/* Today's habits, and a tick each.
 *
 * The whole card is one tap deep on purpose. A habit list that needs a screen of its own before
 * anything can be ticked is a habit list that stops being ticked around day four — so the thing
 * somebody does every day is here, and everything else (renaming, retiring, the history) is
 * behind a long-press-sized target on the row itself.
 *
 * All the arithmetic is the domain's and is shared with the coach's side, so "four of five this
 * week" means the same thing on both screens, in the same week — which under fa-IR runs Saturday
 * to Friday.
 */
export default function Habits() {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const habits = activeHabits(S)
  const today = todayISO()

  const toggle = id => update(s => { s.habitTicks = toggledTicks(s.habitTicks, id, today) })

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: habits.length ? 8 : 6 }}>
        <h2 style={{ margin: 0 }}>{t('Habits')}</h2>
        <button className="iconbtn" onClick={newHabitSheet} aria-label={t('Add a habit')}>
          <Icon name="plus" />
        </button>
      </div>

      {habits.length === 0 ? (
        <div className="muted small">
          {t('The things that happen between sessions. Add one and tick it off each day.')}
        </div>
      ) : (
        <div className="list" style={{ gap: 0 }}>
          {habits.map(h => {
            const dates = datesFor(S.habitTicks, h.id)
            const wk = weekProgress(h, dates, today)
            const run = currentRunDays(h, dates, today)
            const streak = habitStreakWeeks(h, dates, today)
            const ticked = isTickedOn(S, h.id, today)
            return (
              /* The tick and the name are two targets on one row, because they do different
               * things and one of them happens every day. `.lrow-m` is the same middle column
               * `Row` uses, so this sits in a list with the app's other rows without redrawing
               * the hairlines. */
              <div key={h.id} className="lrow">
                <Check checked={ticked} onChange={() => toggle(h.id)} />
                <button className="lrow-m" onClick={() => habitSheet(h.id)}
                  style={{ background: 'none', textAlign: 'start' }}>
                  <span className="lrow-t" style={ticked ? { color: 'var(--label-2)' } : null}>{h.title}</span>
                  <span className="lrow-s">{subtitle(wk, run, streak)}</span>
                </button>
                <span className="lrow-v">
                  {wk.met
                    ? <Icon name="check" style={{ color: 'var(--acc)' }} />
                    : t('{0} of {1}', fmtInt(wk.done), fmtInt(wk.target))}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* What to say under a habit's name, in the order somebody cares about it.
 *
 * A run of days is the most motivating true thing there is, so it leads when there is one — but
 * only for a daily habit, because `currentRunDays` answers null for the rest rather than a
 * number that would read as a verdict. A streak of weeks is the equivalent for a habit with rest
 * built into it. With neither, the week's own count is enough, and nothing at all is better than
 * a decorated zero.
 */
function subtitle(wk, run, streak) {
  if (run > 0) return t('{0} days in a row', fmtInt(run))
  if (streak > 0) return t('{0} weeks on target', fmtInt(streak))
  if (wk.done > 0) return t('{0} this week', fmtInt(wk.done))
  return t('Not yet this week')
}
