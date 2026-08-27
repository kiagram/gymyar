#!/usr/bin/env node
/* migrate / seed / reset — the three things you need before the API will start. */
import { migrate, reset, close, db } from './index.js'
import { seedExercises } from './seed-exercises.js'
import { seedDemo } from './seed-demo.js'

const log = m => console.log(m)
const cmd = process.argv[2]

try {
  if (cmd === 'migrate') {
    const { ran, total } = await migrate({ log })
    log(ran ? `${ran} migration(s) applied` : `up to date (${total} migrations)`)
  } else if (cmd === 'seed') {
    await migrate({ log })
    await seedExercises({ log })
  } else if (cmd === 'demo') {
    await migrate({ log })
    await seedExercises({ log })
    await seedDemo({ log })
  } else if (cmd === 'reset') {
    if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset in production')
    await reset(); log('schema dropped')
    await migrate({ log }); await seedExercises({ log })
    if (process.env.SEED_DEMO) await seedDemo({ log })
  } else if (cmd === 'ping') {
    const [r] = await db()`select now()`; log(`ok ${r.now.toISOString()}`)
  } else {
    log('usage: gymyar-db <migrate|seed|demo|reset|ping>'); process.exitCode = 1
  }
} catch (e) {
  console.error(e.message); process.exitCode = 1
} finally {
  await close()
}
