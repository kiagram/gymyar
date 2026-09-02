/* @gymyar/domain — runtime-agnostic training logic.
 *
 * Everything here runs unchanged in the browser, in the API and in the AI worker:
 * no DOM, no React, no Vite-only syntax. That is the contract, and it is what lets
 * the server generate and validate a programme with exactly the rules the client
 * used to log it. Anything needing a browser stays in apps/client/src/lib.
 */
export * from './i18n-adapter.js'
export * from './names/index.js'
export * from './messages.js'
export * from './format.js'
export * from './calendar.js'
export * from './checkin.js'
export * from './habits.js'
export * from './exercises-data.js'
export * from './exercises.js'
export * from './history.js'
export * from './progression.js'
export * from './onerm.js'
export * from './effort.js'
export * from './heartrate.js'
export * from './muscles.js'
export * from './import-csv.js'
export * from './starter.js'
export * from './statemap.js'
export * from './planner.js'
export * from './parse-log.js'
export * from './entitlement.js'
export * from './phone.js'
