/* Read a user's whole account back as the state object the domain works in.
 *
 * The planner and the review both take the app's state shape rather than rows. That is on
 * purpose: it is the same code the client runs, so a review the server computes and one the
 * client could compute are the same review. The alternative — a second, server-flavoured
 * implementation reading rows directly — is exactly the drift that eats correctness.
 */
import { pullAll } from '@gymbuddy/db/sync.js'
import { applyRows, makeModeResolver } from '@gymbuddy/domain'

export async function stateForUser(userId) {
  const { changes } = await pullAll(userId)
  const modeFor = makeModeResolver(changes.routines || [])
  return applyRows({}, changes, { modeFor })
}
