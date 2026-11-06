import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { blankLine, defaultGstRate, linesToSend, withGstRule } from '@/lib/invoice-lines'
import { CONSTITUTION_LABEL, CONSTITUTION_ORDER } from '@/lib/constitution'

/**
 * docs/88 — the invoice form carried a hidden 18% on every line and had no field to change it.
 * An entity that may not collect GST was therefore refused on every save.
 */
describe('invoice lines for an entity that may not charge GST', () => {
  it('🔴 starts every line at 0, not the hidden 18', () => {
    expect(defaultGstRate(false)).toBe('0')
    expect(blankLine(false).gstRatePct).toBe('0')
  })

  it('a registered entity still starts at 18', () => {
    expect(defaultGstRate(true)).toBe('18')
    expect(blankLine(true).gstRatePct).toBe('18')
  })

  it('🔴 sends 0 even for a draft that was opened carrying 18', () => {
    const stale = { ...blankLine(true), description: 'Work', rate: '100' }
    expect(withGstRule([stale], false)[0].gstRatePct).toBe('0')
    expect(linesToSend([stale], false)[0].gstRatePct).toBe('0')
  })

  it('leaves a registered entity’s lines exactly as typed', () => {
    const l = { ...blankLine(true), description: 'Work', rate: '100', gstRatePct: '12' }
    expect(linesToSend([l], true)[0].gstRatePct).toBe('12')
  })

  it('saves only lines that say something, and the preview still sees a half-typed one', () => {
    const half = { ...blankLine(true), rate: '100' }
    expect(linesToSend([half], true)).toHaveLength(0)
    expect(withGstRule([half], true)).toHaveLength(1)
  })
})

describe('the personal account', () => {
  it('is what the stored PROPRIETORSHIP value is called', () => {
    expect(CONSTITUTION_LABEL.PROPRIETORSHIP).toBe('Personal account')
  })

  it('every constitution has a label and is offered once, personal account first', () => {
    expect(new Set(CONSTITUTION_ORDER).size).toBe(CONSTITUTION_ORDER.length)
    expect(CONSTITUTION_ORDER[0]).toBe('PROPRIETORSHIP')
    for (const c of CONSTITUTION_ORDER) expect(CONSTITUTION_LABEL[c]).toBeTruthy()
    expect(Object.keys(CONSTITUTION_LABEL).sort()).toEqual([...CONSTITUTION_ORDER].sort())
  })
})

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

describe('🔴 nothing hard-codes the label or the 18 again', () => {
  const sources = files('src').filter((p) => !p.endsWith(join('lib', 'constitution.ts')) && !p.endsWith(join('lib', 'invoice-lines.ts')))
  const read = (p: string) => readFileSync(p, 'utf8')

  it('sees the code it is sweeping', () => {
    expect(sources.length).toBeGreaterThan(200)
    expect(sources.filter((p) => /CONSTITUTION_LABEL|blankLine\(/.test(read(p))).length).toBeGreaterThanOrEqual(2)
  })

  it('no screen spells out “Proprietorship” as an option or a label', () => {
    const offenders = sources.filter((p) => /['"`>]Proprietorship['"`<]/.test(read(p)))
    expect(offenders).toEqual([])
  })

  it('no SALES form invents its own starting GST rate', () => {
    // scoped to the invoice screens on purpose: the VENDOR-bill form carries the same hidden 18
    // and is a different question (input credit on a purchase), recorded in docs/88 §6
    const invoiceForms = sources.filter((p) => p.includes(join('(app)', 'invoices')) && /['"]use client['"]/.test(read(p)))
    expect(invoiceForms.length).toBeGreaterThanOrEqual(1)
    expect(invoiceForms.filter((p) => /gstRatePct:\s*'18'/.test(read(p)))).toEqual([])
  })
})
