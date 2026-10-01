/**
 * Project-local PostgreSQL for development.
 *
 * Keeps its data in ./.pgdata on port 5461 — no system install, no superuser
 * password, nothing shared with the PostgreSQL 17 already on this machine.
 * Production uses a real DATABASE_URL; this only exists so `npm run dev` works.
 *
 *   npx tsx scripts/pg.ts start | stop | status
 */
import EmbeddedPostgres from 'embedded-postgres'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const DATA_DIR = resolve(process.cwd(), '.pgdata')
const PORT = 5461
const USER = 'adpedia'
const PASSWORD = 'adpedia'
const DATABASE = 'adpedia'

export const DEV_DATABASE_URL = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`

function instance() {
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  })
}

async function start() {
  const pg = instance()
  const fresh = !existsSync(DATA_DIR)
  if (fresh) {
    console.log('initialising cluster in .pgdata …')
    await pg.initialise()
  }
  await pg.start()
  if (fresh) {
    await pg.createDatabase(DATABASE)
    console.log(`created database "${DATABASE}"`)
  }
  console.log(`postgres up on port ${PORT}`)
  console.log(`DATABASE_URL="${DEV_DATABASE_URL}"`)
}

async function stop() {
  await instance().stop()
  console.log('postgres stopped')
}

const cmd = process.argv[2] ?? 'start'
const run = cmd === 'stop' ? stop : start
run().catch((e) => { console.error(e); process.exit(1) })
