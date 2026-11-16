import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { envProblems } from '@/lib/env'

const base = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(40) }

describe('🔴 docs/95 — the environment is validated in one place', () => {
  it('accepts the minimum', () => {
    expect(envProblems({ ...base })).toEqual([])
  })

  it('treats an empty value as not set, as .env.example ships them', () => {
    expect(envProblems({ ...base, CRON_SECRET: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })).toEqual([])
  })

  it('refuses a scheduler secret that is too short to be one', () => {
    expect(envProblems({ ...base, CRON_SECRET: 'short' }).join()).toMatch(/CRON_SECRET/)
  })

  it('refuses a WebAuthn origin that is not an origin', () => {
    expect(envProblems({ ...base, WEBAUTHN_ORIGIN: 'localhost:3000' }).join()).toMatch(/WEBAUTHN_ORIGIN/)
  })

  it('refuses half a push key pair', () => {
    expect(envProblems({ ...base, VAPID_PUBLIC_KEY: 'pub' }).join()).toMatch(/together/)
    expect(envProblems({ ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' })).toEqual([])
  })

  it('refuses an unknown switch value rather than silently treating it as the default', () => {
    expect(envProblems({ ...base, FX_LIVE_RATES: 'no' }).join()).toMatch(/FX_LIVE_RATES/)
    expect(envProblems({ ...base, IRP_MODE: 'prod' }).join()).toMatch(/IRP_MODE/)
  })

  it('in production, wants an https origin and no s3 driver', () => {
    const prod = { ...base, NODE_ENV: 'production' }
    expect(envProblems({ ...prod, WEBAUTHN_ORIGIN: 'http://billing.adpedia.in' }).join()).toMatch(/https/)
    expect(envProblems({ ...prod, WEBAUTHN_ORIGIN: 'https://billing.adpedia.in' })).toEqual([])
    expect(envProblems({ ...prod, STORAGE_DRIVER: 's3' }).join()).toMatch(/not implemented/)
  })

  it('.env.example, copied as-is with a real secret, is a valid environment', () => {
    const lines = readFileSync('.env.example', 'utf8').split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
    const parsed = Object.fromEntries(lines.map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]
    }))
    expect(envProblems({ ...parsed, JWT_SECRET: 'x'.repeat(40) })).toEqual([])
  })
})
