/* Root config, for the command a person actually types.
 *
 * Every workspace has a `test` script and `npm test` runs them one after another — that path was
 * always fine. This is for `npx vitest run` from the repo root, which is what anybody does when
 * they want the whole suite in one go, or one file by path.
 *
 * It fixes two things that made that command lie.
 *
 * **The worktrees.** `.claude/worktrees` holds scratch checkouts of this same repo — four of
 * them at the time of writing, each a full copy with its own tests. A root run walked them, took
 * three times as long, reported counts nobody could reconcile with the source in front of them,
 * and failed on abandoned work that was never meant to be green. The directory is gitignored;
 * vitest's default excludes are about build output and do not know that.
 *
 * **The shared database.** `packages/db` and `apps/api` disable `fileParallelism` in their own
 * configs, because both suites talk to one Postgres and truncate each other's rows mid-assertion
 * otherwise. A flat root run does not pick those up, so it produced three hundred failures that
 * looked like broken code and were a missing flag. Listing them as projects is what makes their
 * own configs apply — so one command behaves exactly like eight.
 */
export default {
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '.claude/**',
      'apps/client/android/**',
      'apps/client/ios/**'
    ],
    /* Named rather than globbed. A glob would pick up whatever appears next — including a
     * scratch copy of this repo, which is the thing this file exists to keep out. */
    projects: [
      'packages/domain',
      'packages/ai',
      'packages/db',
      'packages/storage',
      'packages/mail',
      'packages/sms',
      'apps/api',
      'apps/client'
    ]
  }
}
