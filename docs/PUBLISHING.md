# Where this code should live

## The remote in this tree is not yours

`git remote -v` shows `source` pointing at `github.com/arvids-unavailable/openGym`. That is where
the openGym code was read from — a community re-upload, not the canonical project and not your
repository. It is named `source` rather than `origin` so a reflexive `git push` cannot send your
work there.

**Do not push to it.** Nine commits of GymYar in a stranger's public tree helps nobody, and the
re-upload is the one carrying [a leaked session secret](../NOTICE.md).

## Setting up your own

**Done for this tree:** `origin` is <https://github.com/kiagram/gymyar>, public, with both
`gymyar` and `main` pushed and `gymyar` as the default branch. Repository and branch both read
as the product. For a while only the repository did — the branch kept `gymbuddy`, the name the
fork was started under, on the argument that a branch name appears in no URL and so costs
nothing to leave alone. That is true and it is not the whole cost: it is a second name for the
same thing, in the two documents that tell somebody else how to contribute, and every reader
has to be told which one is which. One name is cheaper than the explanation.

GitHub's own branch rename was used rather than a push-and-delete, so the old name still
resolves and a clone taken before it keeps fetching. What follows is what was run, and what a
fork of this project would run in turn.

It was `kiagram/gymbuddy` until the rename, which is the name the fork was started under and
the last thing still carrying it. Renaming a repository does not break anything already
pointed at the old name — GitHub redirects it, for the web and for `git` alike — so an existing
clone keeps fetching and only wants `git remote set-url` for tidiness. This tree has had it:

```bash
git remote set-url origin https://github.com/kiagram/gymyar.git
```

The redirect is a courtesy and not an address. It lapses the moment anyone creates a new
repository under the old name, which is a thing you can do to yourself by accident, so nothing
written down should keep pointing there.

Create an empty repository wherever you want this to live, then:

```bash
git remote add origin <your-repo-url>
git push -u origin gymyar
```

The `main` branch in this tree is still the openGym import, untouched. Keeping it is useful — it
is what `git log gymyar ^main` diffs against, and it is the attribution trail. Push it too if
you want that history preserved:

```bash
git push origin main
```

## AGPL: this has to be public

GymYar inherits openGym's AGPL-3.0, and you chose to stay on it. Section 13 means anyone using
a hosted instance is entitled to its source. The App Store additional permission you inherit
([NOTICE.md](../NOTICE.md)) makes that a condition too: it allows store distribution *provided the
corresponding source remains available under the AGPL at the project repository*.

So the repository has to be public before you take payment or ship to a store. A private repo with
a public deployment is the one combination the licence does not allow.

## Do not depend on one host

The reason `source` exists at all is that the original author's GitHub account was suspended and
`DuarteSantos8/openGym` started returning 404 — which is why a community re-upload was the only
thing left to read. The canonical project moved to
[gitea.com/DuarteSantos/openGym](https://gitea.com/DuarteSantos/openGym).

That can happen to you. Push to a second remote from the start:

```bash
git remote add mirror <second-host-url>
git push mirror gymyar
```

## What must never be committed

`.gitignore` already covers these, and they are the reason the re-upload is unsafe to run:

- `data/` — session signing secret, VAPID private key, user records
- `media/` — 2,649 Gym visual files that are not licensed to you
- `.env` — `SESSION_SECRET`, database credentials, and whichever model API key you set

Before the first push, check nothing slipped in:

```bash
git ls-files | grep -E '^(data|media)/|\.env$'    # should print nothing
```
