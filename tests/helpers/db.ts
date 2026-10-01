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
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `
  const list = tables.map((t) => `"${t.tablename}"`).join(', ')
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
  await seedAll(prisma, { quiet: true, ownerEmail: 'test@adpedia.local', ownerPassword: 'test' })
}
