import { useState } from 'react'
import { imgSrc, gifSrc } from '@gymyar/domain'
import { useStore } from '../store/useStore.js'
import { t, exName } from '../lib/i18n.js'
import Icon from './Icon.jsx'

// Big autoplaying animation; tap toggles to the still frame. `compact` shrinks it (superset cards).
// Custom exercises have no media — the animation stays blank by design (issue #11).
// `minimizable` (workout view) adds a persistent minimize/expand control so the animation stops
// eating the screen; the chosen size is saved to settings and carries across exercises and
// future workouts (issue #12).
export default function Media({ ex, id, compact, minimizable }) {
  const [playing, setPlaying] = useState(true)
  const gifSize = useStore(s => s.S.gifSize)
  const update = useStore(s => s.update)
  // Asked of the resolver rather than of `ex.gif`, because the active media set decides this
  // now and the dataset's own field is only its answer when no set overrides it. An exercise a
  // replacement set does not cover has no artwork, and this is where that becomes no element.
  const gif = gifSrc(ex), img = imgSrc(ex)
  if (!gif && !img) return null
  const mini = minimizable && gifSize === 'mini'
  const toggleSize = e => { e.stopPropagation(); update(s => { s.gifSize = mini ? 'full' : 'mini' }) }
  return (
    <div className={'exmedia' + (compact ? ' compact' : '') + (mini ? ' mini' : '')} id={id} onClick={() => setPlaying(p => !p)}>
      <img decoding="async" src={playing ? (gif || img) : (img || gif)} alt={exName(ex)} />
      {minimizable && (
        <button className="giftoggle" onClick={toggleSize}>
          <Icon name={mini ? 'expand' : 'minimize'} />{mini ? t('Expand') : t('Minimize')}
        </button>
      )}
      {/* Only when there are two frames to move between. A set holding a still and no
        * animation would otherwise offer to pause something that is not playing. */}
      {!mini && gif && img && (
        <span className="gifhint">
          <Icon name={playing ? 'pause' : 'play'} />{playing ? t('tap to pause') : t('tap to play')}
        </span>
      )}
    </div>
  )
}

export function Thumb({ ex }) {
  // The dumbbell placeholder was written for custom exercises, which have no artwork. It is
  // now also what an exercise outside the active media set gets, which is the same situation
  // arrived at from the other direction — and a row that renders rather than a hole.
  const src = imgSrc(ex) || gifSrc(ex)
  if (!src) return <div className="thumb thumb-x"><Icon name="dumbbell" /></div>
  return <img className="thumb" loading="lazy" decoding="async" src={src} alt="" />
}
