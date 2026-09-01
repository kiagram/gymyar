/* Empty files where the exercise artwork would be, named the way the dataset names it.
 *
 * The exercise media is 140 MB fetched from a third party's repository on first boot, and
 * there are two situations where paying for that is not worth it: CI, which builds the whole
 * compose stack on every push and does not look at a single picture, and anybody bringing the
 * stack up locally to work on something that is not the library.
 *
 * The media service in docker-compose.yml already has the switch — it skips the download when
 * `./media/img` is non-empty — and for a long time CI simply touched one file called
 * `.ci-placeholder` to flip it. That stopped being enough when `smoke.sh` started following an
 * exercise's `image_url` and `animation_url` to see that they resolve: the names in those
 * columns are the dataset's (`0001-2gPfomN.jpg`), so a directory holding one arbitrarily-named
 * file answers 404 for every one of them.
 *
 * So the placeholders carry the dataset's own filenames, read from the same `EXDB` the seeder
 * reads. Be clear about what that does and does not establish. It proves the name the seeder
 * stored is the name the dataset declares — which is exactly the bug that put `/img/<id>.jpg`
 * in all 1,324 rows and 404'd every one of them. It does not prove upstream still ships those
 * bytes; only the real download would, and that is 140 MB per run spent re-verifying somebody
 * else's tree.
 *
 * Empty files rather than valid images, because nothing here decodes one — `smoke.sh` reads a
 * status code. A test that wants pixels wants the real media.
 *
 *   node infra/scripts/media-placeholders.mjs [dir]     (default ./media)
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EXDB } from '@gymyar/domain'

const root = process.argv[2] || 'media'
const img = join(root, 'img')
const gif = join(root, 'gif')

await mkdir(img, { recursive: true })
await mkdir(gif, { recursive: true })

// `e.img` and `e.gif` and nothing derived: the point of the file is to be named what the
// library says it is named. A record without one would silently write `media/img/undefined`,
// which is a file that exists and answers 200 for a URL nobody asked for — so it is refused.
const nameless = EXDB.filter(e => !e.img || !e.gif)
if (nameless.length) {
  console.error(`${nameless.length} exercise(s) carry no filename — first: ${nameless[0].id}`)
  process.exit(1)
}

await Promise.all(EXDB.flatMap(e => [
  writeFile(join(img, e.img), ''),
  writeFile(join(gif, e.gif), '')
]))

console.log(`✓ ${EXDB.length * 2} media placeholders in ${root}/ — no bytes, the right names.`)
