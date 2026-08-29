/* The numbers a review was drawn from, said plainly and never rated.
 *
 * ## Why this is a list and not a chart
 *
 * `signals` carries a trend, not a series — a slope, a mean, the ends and how many readings
 * there were. That is deliberate on the server's side (`readSignals` in `domain/src/planner.js`)
 * and it settles the question here: there are no points to plot.
 *
 * ## Why it does not repeat the rate
 *
 * The findings above already say "body weight is down 1.0 kg a week", and printing that again
 * six lines later is the filler that makes people stop reading the lines that matter. So this
 * says the thing the findings do not: where the number started, where it is now, and how many
 * readings that rests on. Between them the reader gets the judgement and the working, once each.
 *
 * ## What is missing from it on purpose
 *
 * No colour, no arrows, no good and bad. A waist coming down and an arm coming down are the
 * same number and opposite news, and the field carries no way to tell them apart — so the
 * domain refuses to rate a measurement and this refuses to imply one. The findings are where
 * judgement lives, and they are judgements the domain could defend.
 *
 * The same goes for a scale nobody named a direction for: it shows the average out of five and
 * says nothing about whether five is where you want to be.
 */
import { fmtNum, fmtInt } from '@gymyar/domain'
import { t } from '../lib/i18n.js'
import { Section, Row } from './ui.jsx'

const withUnit = (value, unit) => (unit ? `${fmtNum(value)} ${unit}` : fmtNum(value))

/**
 * Where a measured thing started and where it is now.
 *
 * Written out rather than drawn with an arrow: "84 → 81" mirrors under RTL into something whose
 * direction the reader has to work out, and this sentence reads the same way round in both.
 * Two readings of the same number is not a span, so that case says only how many there were.
 */
function spanLine(tr, unit) {
  const readings = fmtInt(tr.n)
  if (tr.n < 2 || tr.first === tr.last) return t('{0} readings so far', readings)
  return t('From {0} to {1}, across {2} readings', fmtNum(tr.first), withUnit(tr.last, unit), readings)
}

/**
 * @param signals  the `signals` block from a review; null or empty renders nothing
 * @param title    the section heading — "what you recorded" and "what they recorded" are not
 *                 the same sentence, and this component is shown to both people
 */
export default function Signals({ signals, title = null }) {
  const scales = Object.entries(signals?.scales || {})
  const measures = Object.entries(signals?.measures || {})
  if (!signals?.weight && !scales.length && !measures.length) return null

  return (
    <Section
      title={title || t('What you recorded')}
      footer={t('Straight from the weigh-ins and check-ins themselves. A measurement moving is not good or bad on its own, so nothing here is rated.')}
    >
      {signals.weight && (
        <Row
          title={t('Body weight')}
          value={withUnit(signals.weight.last, signals.weight.unit)}
          subtitle={spanLine(signals.weight, signals.weight.unit)}
        />
      )}

      {/* A coach's own label travels as they wrote it: `t` hands back the key it cannot
          translate, which is exactly right for words this app did not choose. */}
      {scales.map(([key, s]) => (
        <Row key={key} title={t(s.label)}
             value={t('{0} of 5', fmtNum(s.mean))}
             subtitle={t('Across {0} check-ins', fmtInt(s.n))} />
      ))}

      {measures.map(([key, m]) => (
        <Row key={key} title={t(m.label)}
             value={withUnit(m.last, m.unit)}
             subtitle={spanLine(m, m.unit)} />
      ))}
    </Section>
  )
}
