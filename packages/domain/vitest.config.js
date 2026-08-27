/* This exists to anchor vitest's root at this package.
 *
 * `root` defaults to the directory of whichever config file vitest finds, and it searches
 * upward. Without this, `npm run test -w @gymyar/domain` would find the repo's root config and
 * run every workspace's tests — or fail on a `projects` list whose paths mean nothing from
 * here. The root config is what makes a bare `npx vitest run` behave; this is what keeps the
 * per-workspace script meaning one workspace.
 */
export default { test: {} }
