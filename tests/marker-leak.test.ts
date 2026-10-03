import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src')
const TEMPLATES = join(process.cwd(), 'templates')

function files(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, exts, out)
    else if (exts.some((x) => e.endsWith(x))) out.push(p)
  }
  return out
}

/**
 * 🔴 Comment-aware, not line-prefix-aware.
 *
 * The first version tested whether the LINE began with a comment marker, and reported
 * thirty false positives: the body of every multi-line `/* ... *\/` and `<!-- ... -->` block,
 * whose continuation lines begin with prose. A guard that cries wolf thirty times is a guard
 * somebody deletes.
 *
 * So the comments are removed and the question is asked of what is left.
 */
function withoutComments(src: string): string {
  let out = '', i = 0
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      const skipped = src.slice(i, end < 0 ? src.length : end + 2)
      // keep the newlines so line numbers survive
      out += skipped.replace(/[^\n]/g, ' ')
      i = end < 0 ? src.length : end + 2
    } else if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      out += src.slice(i, end < 0 ? src.length : end + 3).replace(/[^\n]/g, ' ')
      i = end < 0 ? src.length : end + 3
    } else if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i)
      out += src.slice(i, end < 0 ? src.length : end).replace(/[^\n]/g, ' ')
      i = end < 0 ? src.length : end
    } else {
      out += src[i]; i += 1
    }
  }
  return out
}

/**
 * 🔴 The marker is for the people reading this code, never for the people using it.
 *
 * It has leaked into user-facing text four times — an engine note and screen copy in
 * docs/46 and docs/47, a field hint in docs/54, and in docs/61 into the body of an email
 * that would have gone to a client, explaining to them that their own unreported deduction
 * was "a real cost to us". Each time it was caught by reading the output, which means each
 * time it could have been missed.
 *
 * A line carrying the marker outside a comment is the whole signature of the mistake, so
 * that is what this looks for.
 */
describe('🔴 the marker never reaches a user', () => {
  const sources = [...files(SRC, ['.ts', '.tsx']), ...files(TEMPLATES, ['.html'])]

  it('finds the source files', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('appears only in comments', () => {
    const leaks: string[] = []
    for (const f of sources) {
      // this test itself quotes the marker in prose, by necessity
      if (f.endsWith('marker-leak.test.ts')) continue
      const stripped = withoutComments(readFileSync(f, 'utf8'))
      stripped.split('\n').forEach((line, i) => {
        if (line.includes('\u{1F534}')) {
          leaks.push(`${f.slice(process.cwd().length + 1)}:${i + 1}  ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(leaks, `the marker is outside a comment here:\n${leaks.join('\n')}`).toEqual([])
  })
})
