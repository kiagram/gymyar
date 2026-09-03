/* Which artwork the exercise library points at, and what entitles us to point at it.
 *
 * This file is the whole answer to the licence question, in one object, imported by both the
 * client and the seeder. Replacing the media is replacing this file — not an environment
 * variable, not a migration, and not a code change spread across three runtimes.
 *
 * The reason it exists is that the thing this project has been telling itself is not true.
 * README.md, CHANGELOG.md, 001_init.sql and seed-exercises.js all say some version of
 * "replacing the artwork is an UPDATE over the exercises table". The columns are real and the
 * seeder fills them correctly, but nothing that draws a picture reads them: `Media.jsx` calls
 * `imgSrc`/`gifSrc`, which are `IMG_BASE + ex.img`, and `ex.img` is a Gym visual filename
 * compiled into `exercises-data.js` and shipped in the bundle. An UPDATE would change the
 * columns and not one pixel on screen.
 *
 * ## What a set is
 *
 * `media: null` means the dataset names its own files — `ex.img` and `ex.gif`, the current and
 * historical behaviour. A replacement set gives `media` a map from library id to filenames or
 * absolute URLs, and that map is then *authoritative, including about what it omits*: an
 * exercise the set does not cover renders no picture at all rather than quietly falling back
 * to the artwork we would be replacing in order to stop shipping. A fallback would make the
 * swap look complete while leaving the licence exposure exactly where it was, which is the
 * failure mode this whole file exists to prevent.
 *
 * ## The set that is active
 *
 * Gym visual's, because that is what ships today and saying otherwise here would be the same
 * kind of untruth. `commercial: false` is the machine-readable form of the launch blocker in
 * README.md, and `infra/scripts/media-set.mjs --check` fails on it — so a build that intends
 * to be sold has one assertion to run rather than a document to remember.
 */
export const MEDIA_SET = {
  id: 'gymvisual',
  name: 'Gym visual, via hasaneyldrm/exercises-dataset',
  url: 'https://gymvisual.com/',
  licence: 'proprietary',
  /* Whether this set may be used in something somebody pays for. False here is not a
   * technicality: the dataset grants us nothing, and both the hosted instance and the APK
   * are currently rendering it. */
  commercial: false,
  attribution: '© Gym visual — https://gymvisual.com/',
  media: null
}
