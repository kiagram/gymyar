import { useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { bindUI } from './components/ui.jsx'
import { ACCENTS } from '@gymbuddy/domain'
import { setLang, useLang } from './lib/i18n.js'
import { setNav } from './lib/nav.js'
import { useWakeLock } from './lib/wakelock.js'
import { startFlow } from './sheets.jsx'
import TabBar from './components/TabBar.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Modals from './components/Modals.jsx'
import Toast from './components/Toast.jsx'
import RestTimer from './components/RestTimer.jsx'
import Login from './views/Login.jsx'
import Home from './views/Home.jsx'
import Plan from './views/Plan.jsx'
import RoutineEdit from './views/RoutineEdit.jsx'
import Workout from './views/Workout.jsx'
import Stats from './views/Stats.jsx'
import History from './views/History.jsx'
import Library from './views/Library.jsx'
import Settings from './views/Settings.jsx'
import Admin from './views/Admin.jsx'
import Coach from './views/Coach.jsx'
import CoachClient from './views/CoachClient.jsx'
import Coaching, { InviteAccept } from './views/Coaching.jsx'
import Billing from './views/Billing.jsx'
import { MOBILE } from './lib/mobile.js'
import { DEMO } from './lib/demo.js'
import PlanBuilder from './views/PlanBuilder.jsx'
import mark from './assets/mark.svg'

bindUI(useUI)   // lets the shared controls open sheets without importing the store at module scope

function applyPrefs(theme, accent) {
  const de = document.documentElement
  de.dataset.theme = theme === 'light' ? 'light' : 'dark'
  de.dataset.accent = ACCENTS[accent] ? accent : 'red'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = de.dataset.theme === 'light' ? '#f2f2f7' : '#000000'
}

function Shell() {
  const navigate = useNavigate()
  const loc = useLocation()
  const { S, user, ready } = useStore()
  const isGuest = useStore(s => s.isGuest())
  const langV = useLang()   // re-renders the whole shell when the language (pack) changes
  useEffect(() => { setNav(navigate) }, [navigate])
  useEffect(() => { applyPrefs(S.theme, S.accent) }, [S.theme, S.accent])
  useEffect(() => { setLang(S.lang || 'en') }, [S.lang])
  useEffect(() => { document.documentElement.lang = S.lang || 'en' }, [langV, S.lang])
  // every tab/route change starts at the top of the page
  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])
  // bound to the workout, not to the route — checking Stats mid-session keeps the screen on
  useWakeLock(!!S.active && S.keepAwake !== false)

  const authed = user || isGuest
  if (!ready && !authed) return (
    <div id="app">
      {/* The first paint before anything is known: the mark, held back so it reads as a
          screen still loading rather than a screen that has arrived. */}
      <div style={{ paddingTop: '44vh', display: 'flex', justifyContent: 'center', opacity: .3 }}>
        <img src={mark} alt="" height="44" />
      </div>
    </div>
  )

  return (
    <>
      {/* keyed on the route: a view that throws is contained, and switching tabs
          re-mounts the boundary, so the tab bar is always a way out */}
      <div id="app" className="vfade" key={loc.pathname}>
        <ErrorBoundary>
          {!authed ? <Login /> : (
            <Routes>
              <Route path="/home" element={<Home />} />
              <Route path="/plan" element={<Plan />} />
              <Route path="/plan/build" element={<PlanBuilder />} />
              <Route path="/plan/r/:id" element={<RoutineEdit />} />
              <Route path="/workout" element={<Workout />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/history" element={<History />} />
              <Route path="/library" element={<Library />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/coaching" element={<Coaching />} />
              <Route path="/invite/:code" element={<InviteAccept />} />
              {/* The coach screens are gated on the flag, not hidden by it: a direct link from
                  someone who is not a coach lands on Home rather than an empty roster. */}
              <Route path="/coach" element={user?.isCoach ? <Coach /> : <Navigate to="/home" replace />} />
              <Route path="/coach/:id" element={user?.isCoach ? <CoachClient /> : <Navigate to="/home" replace />} />
              {/* Not gated on isCoach: somebody whose subscription lapsed still needs to reach
                  the screen that sells them a new one, and a receipt outlives a role.

                  Gated on the build, though. The native shells and the GitHub Pages demo have
                  no backend at all — no accounts, no coaching, nothing to subscribe to — so
                  this screen has nothing to ask and would render an error to anyone who
                  reached it. An app shipped to a store must have no payment surface it cannot
                  honour, which is also the simplest possible answer to every store's rules
                  about who may take the money. */}
              <Route path="/billing" element={MOBILE || DEMO ? <Navigate to="/home" replace /> : <Billing />} />
              <Route path="/admin" element={user?.isAdmin ? <Admin /> : <Navigate to="/home" replace />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          )}
        </ErrorBoundary>
      </div>
      <TabBar onStart={startFlow} />
      <RestTimer />
      <Modals />
      <Toast />
    </>
  )
}

export default function App() {
  const boot = useStore(s => s.boot)
  useEffect(() => { boot() }, [boot])
  return <HashRouter><Shell /></HashRouter>
}
