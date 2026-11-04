import { describe, it, expect } from 'vitest'
import { assertTestDatabase } from './helpers/db'

/**
 * 🔴 docs/83 §8 — the guard on the function that truncates every table.
 *
 * `resetDb` TRUNCATEs the whole schema and nothing checked which database it was pointed at.
 * `npm run test:db` sets `DATABASE_URL` to `adpedia_test` on the command line; run one
 * integration file the obvious way instead — `npx vitest run tests/foo.integration.test.ts` —
 * and Vite loads `.env` into `process.env` itself, so `DATABASE_URL` is the DEVELOPMENT
 * database and `resetDb` wipes it.
 *
 * That is not hypothetical. It happened, and the first sign of it was the test suite going
 * green: a truncated and reseeded database is exactly what an integration test asks for, so
 * nothing failed. The development database lost its second entity, both of its real users and
 * every document raised in it.
 *
 * A convention that has to be remembered is not a guard. This is a precondition.
 */
describe('🔴 resetDb will not truncate a database that is not the test one', () => {
  it('refuses the development database by name', () => {
    expect(() => assertTestDatabase('postgresql://adpedia:adpedia@localhost:5461/adpedia'))
      .toThrow(/refuses to truncate "adpedia"/)
  })

  it('accepts the test database', () => {
    expect(() => assertTestDatabase('postgresql://adpedia:adpedia@localhost:5461/adpedia_test'))
      .not.toThrow()
  })

  it('reads the name past a query string, and is not fooled by one', () => {
    expect(() => assertTestDatabase('postgresql://u:p@h:5461/adpedia_test?schema=public&connection_limit=1'))
      .not.toThrow()
    // 🔴 `?...=adpedia_test` is not the database name
    expect(() => assertTestDatabase('postgresql://u:p@h:5461/adpedia?schema=adpedia_test'))
      .toThrow(/refuses to truncate "adpedia"/)
  })

  it('refuses when nothing is set at all, rather than connecting to a default', () => {
    expect(() => assertTestDatabase('')).toThrow(/DATABASE_URL is not set/)

    // 🔴 and through the real call path, where the argument is omitted and the environment
    // is what decides — which is how `resetDb` calls it
    const real = process.env.DATABASE_URL
    try {
      delete process.env.DATABASE_URL
      expect(() => assertTestDatabase()).toThrow(/DATABASE_URL is not set/)
    } finally {
      if (real === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = real
    }
  })

  it('and reads the environment when the argument is omitted, which is the live call', () => {
    const real = process.env.DATABASE_URL
    try {
      process.env.DATABASE_URL = 'postgresql://u:p@h:5461/adpedia'
      expect(() => assertTestDatabase()).toThrow(/refuses to truncate "adpedia"/)
      process.env.DATABASE_URL = 'postgresql://u:p@h:5461/adpedia_test'
      expect(() => assertTestDatabase()).not.toThrow()
    } finally {
      if (real === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = real
    }
  })

  it('is not fooled by a name that merely contains the word', () => {
    for (const bad of ['adpedia_testing', 'test_adpedia', 'adpedia-test', 'testdb']) {
      expect(() => assertTestDatabase(`postgresql://u:p@h:5461/${bad}`), bad).toThrow(/refuses to truncate/)
    }
  })
})
