// The repository this project lives in — the repo root, no trailing slash. Every source
// link on the site is hidden while this is empty, so a fork that has not published yet
// shows no dead links rather than links into somebody else's tree. See docs/PUBLISHING.md.
const REPO = 'https://github.com/kiagram/gymbuddy'

// Paths use /blob/HEAD/, which GitHub resolves to whatever the default branch is. Not
// /blob/main/: the main branch here is the openGym import, kept as the attribution trail,
// so a link into it serves openGym's CHANGELOG rather than this project's. HEAD also
// survives the default branch being renamed, which a hardcoded name does not.
//
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
