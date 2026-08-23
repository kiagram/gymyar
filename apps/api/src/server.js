import { build } from './app.js'
import { config } from './config.js'
import { close } from '@gymbuddy/db'

const app = await build({ logger: { level: process.env.LOG_LEVEL || 'info' } })

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    app.log.info('shutting down')
    await app.close()
    await close()
    process.exit(0)
  })
}

await app.listen({ port: config.port, host: config.host })
