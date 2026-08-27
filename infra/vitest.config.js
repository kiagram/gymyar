/* The release checks run with `--root infra`, which makes this the config vitest reads.
 *
 * Without it the repo's root config is found instead, and its `projects` list — paths relative
 * to the repo root — resolves to `infra/packages/domain` and friends, none of which exist. The
 * failure is a startup error rather than a test one, which is a confusing way to be told that a
 * config file is missing.
 */
export default { test: {} }
