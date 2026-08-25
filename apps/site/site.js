// The repository this project lives in. GymBuddy has no public repo yet — see
// docs/PUBLISHING.md — so every source link on the site is hidden until this is set.
// Set it to the repo root with no trailing slash, e.g. 'https://github.com/you/gymbuddy',
// and the links below reveal themselves. That is the only edit needed.
const REPO = ''

// Anything carrying data-repo is a link into the repository: the attribute is the path to
// append. Empty attribute means the repo root. With REPO unset they stay hidden rather than
// pointing somewhere wrong — a dead link to a repository that does not exist yet is worse
// than no link, and this site is served without a build step, so this is where that lives.
for (const el of document.querySelectorAll('[data-repo]')) {
  if (!REPO) continue
  el.href = REPO + el.dataset.repo
  el.rel = 'noopener'
  el.hidden = false
}
