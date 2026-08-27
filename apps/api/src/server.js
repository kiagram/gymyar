import { build } from './app.js'
import { config } from './config.js'
import { close } from '@gymyar/db'
import { startSweeper } from './sweeper.js'
import { startReminders } from './reminders.js'

const app = await build({ logger: { level: process.env.LOG_LEVEL || 'info' } })

/* Deleted media stops being visible the moment somebody deletes it and stops *existing* when
 * this runs. It is started here rather than inside `build()` on purpose: the test suite builds
 * dozens of apps in one process and none of them should acquire a background timer. */
const stopSweeper = startSweeper({ log: app.log })
const stopReminders = startReminders({ log: app.log })

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    app.log.info('shutting down')
    stopSweeper()
    stopReminders()
    await app.close()
    await close()
    process.exit(0)
  })
}

await app.listen({ port: config.port, host: config.host })
