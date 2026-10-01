// Create/drop databases on the project-local dev cluster (port 5461).
// Touches nothing outside ./.pgdata, which this project created.
import pg from 'pg'
const [,, action, dbName] = process.argv
const client = new pg.Client({ host: 'localhost', port: 5461, user: 'adpedia', password: 'adpedia', database: 'postgres' })
await client.connect()
try {
  if (action === 'create') {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (rowCount) { console.log(`database "${dbName}" already exists`) }
    else { await client.query(`CREATE DATABASE "${dbName}"`); console.log(`created database "${dbName}"`) }
  } else if (action === 'recreate') {
    await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName])
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`)
    await client.query(`CREATE DATABASE "${dbName}"`)
    console.log(`recreated database "${dbName}"`)
  } else { console.error('usage: pg-admin.mjs create|recreate <dbname>'); process.exit(1) }
} finally { await client.end() }
