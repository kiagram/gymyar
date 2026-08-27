// Demo build (VITE_DEMO=1) — what runs on the GitHub Pages deployment.
//
// Pages can only serve static files, so there is no API: passkey sign-in, per-profile sync
// and the admin dashboard all need the Node backend and are simply not part of a demo build.
// The app therefore stays in guest mode (everything in localStorage) and boots with a seeded
// example history (demo-seed.js in @gymyar/domain), so the charts, heatmap, streaks and "last time you lifted…"
// pre-fills have something to show instead of an empty shell.
//
// Only these three constants are shared with normal builds: Vite replaces VITE_DEMO at build
// time, so the demo-only UI folds away and the seed generator — imported dynamically — never
// lands in a self-hosted bundle.
export const DEMO = import.meta.env.VITE_DEMO === '1'
export const DEMO_SEEDED = 'gym_demo_seeded_v1'
/* Where *this* project's source lives. Every "self-host GymYar" link points here, and under
 * AGPL section 13 offering it to anyone using a hosted instance is an obligation rather than a
 * courtesy — so it has to be our repository, not the one we forked. It pointed at openGym's
 * until now, which sent everyone who tapped "Self-host GymYar" to a different product.
 *
 * Empty until GymYar has a public repository (docs/PUBLISHING.md). Every link that uses it
 * is hidden while it is empty: no link is better than a link to somebody else's project. */
export const REPO = ''
