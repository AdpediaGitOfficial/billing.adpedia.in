import { PrismaClient } from '@prisma/client'
import { seedAll } from '../../prisma/seed'

/**
 * Integration tests share one database, so each file resets it in beforeAll.
 *
 * TRUNCATE rather than DELETE: the no-hard-delete triggers are BEFORE DELETE and
 * would (correctly) refuse a cleanup. TRUNCATE fires BEFORE TRUNCATE triggers, of
 * which there are none — so the production guard stays intact while tests still
 * start from a known state.
 */
export async function resetDb(prisma: PrismaClient) {
  assertTestDatabase()

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `
  const list = tables.map((t) => `"${t.tablename}"`).join(', ')
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
  await seedAll(prisma, { quiet: true, ownerEmail: 'test@adpedia.local', ownerPassword: 'test' })
}

/**
 * 🔴 docs/83 §8 — this function TRUNCATES EVERY TABLE, and nothing checked which database.
 *
 * `npm run test:db` sets `DATABASE_URL` to `adpedia_test` on the command line. Run a single
 * integration file the obvious way instead — `npx vitest run tests/foo.integration.test.ts` —
 * and Vite loads `.env` into `process.env` itself, so `DATABASE_URL` is the DEVELOPMENT
 * database and this wipes it. No error, no warning: the tests pass, because a truncated and
 * reseeded database is exactly what they asked for.
 *
 * That is what happened. The dev database lost its second entity, both of its real users and
 * every document raised in it, and the first sign was a test suite going green.
 *
 * The name is the only thing that distinguishes the two, so the name is checked. It is not a
 * convention to be remembered — it is a precondition, and it fails loudly rather than
 * explaining itself afterwards.
 */
export function assertTestDatabase(url = process.env.DATABASE_URL): void {
  if (!url) {
    throw new Error(
      'resetDb: DATABASE_URL is not set. Integration tests run against the test database — use `npm run test:db`.',
    )
  }
  // the database is the last path segment, before any ?query
  const name = url.split('?')[0].split('/').pop() ?? ''
  if (!/_test$/.test(name)) {
    throw new Error(
      `resetDb refuses to truncate "${name}" — it is not a test database.\n` +
      'This function TRUNCATEs every table. `npm run test:db` points DATABASE_URL at ' +
      'adpedia_test; running vitest directly picks up .env instead, which is the development ' +
      'database. Use `npm run test:db`, or set DATABASE_URL for the one file you are running.',
    )
  }
}
