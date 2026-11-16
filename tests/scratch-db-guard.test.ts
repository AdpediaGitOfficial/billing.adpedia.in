import { describe, it, expect } from 'vitest'
import { assertScratchDatabase as guard } from '../scripts/lib/scratch-db-guard'

/**
 * 🔴 docs/95 — `scripts/tmp-fullseed.mts` writes fictitious documents into whichever database it
 * is pointed at. Production and development are both named `adpedia`; the port is what differs.
 */
const dev = 'postgresql://adpedia:adpedia@localhost:5461/adpedia'
const prod = 'postgresql://adpedia:secret@127.0.0.1:5432/adpedia'

describe('🔴 the demo-data script refuses to write into a real ledger', () => {
  it('runs against the project-local dev cluster', () => {
    expect(() => guard(dev, {})).not.toThrow()
    expect(() => guard('postgresql://u:p@127.0.0.1:5461/adpedia', {})).not.toThrow()
  })

  it('runs against a test database', () => {
    expect(() => guard('postgresql://u:p@localhost:5432/adpedia_test', {})).not.toThrow()
  })

  it('🔴 refuses production — same database NAME as dev, different port', () => {
    expect(() => guard(prod, {})).toThrow(/Refusing to write demo data to 127\.0\.0\.1:5432\/adpedia/)
  })

  it('refuses a remote host even on the dev port', () => {
    expect(() => guard('postgresql://u:p@db.example.com:5461/adpedia', {})).toThrow(/Refusing/)
  })

  it('refuses when the URL is missing or unreadable', () => {
    expect(() => guard(undefined, {})).toThrow(/not set/)
    expect(() => guard('not a url', {})).toThrow(/cannot say where/)
  })

  it('can be overridden only by naming the exact target', () => {
    expect(() => guard(prod, { allow: 'yes' })).toThrow(/Refusing/)
    expect(() => guard(prod, { allow: '127.0.0.1:5432/other' })).toThrow(/Refusing/)
    expect(() => guard(prod, { allow: '127.0.0.1:5432/adpedia' })).not.toThrow()
  })

  it('🔴 refuses NODE_ENV=production even for an allowed target', () => {
    expect(() => guard(dev, { nodeEnv: 'production' })).toThrow(/NODE_ENV=production/)
    expect(() => guard(prod, { allow: '127.0.0.1:5432/adpedia', nodeEnv: 'production' })).toThrow(/NODE_ENV=production/)
  })
})
