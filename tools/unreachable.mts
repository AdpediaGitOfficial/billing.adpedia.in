import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** docs/49's survey, re-run: exported service functions that nothing outside their own file calls. */
const files = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

const SRC = join(process.cwd(), 'src')
const TESTS = join(process.cwd(), 'tests')
const all = [...files(SRC), ...files(TESTS)]
const bodies = new Map(all.map((f) => [f, readFileSync(f, 'utf8')]))

const services = files(join(SRC, 'server', 'services'))
const rows: { fn: string; file: string; callers: number; tests: number }[] = []

for (const f of services) {
  const src = bodies.get(f)!
  for (const m of src.matchAll(/^export (?:async )?function (\w+)/gm)) {
    const fn = m[1]
    let callers = 0, tests = 0
    for (const [other, body] of bodies) {
      if (other === f) continue
      const hits = (body.match(new RegExp(`\\b${fn}\\b`, 'g')) ?? []).length
      if (hits === 0) continue
      if (other.startsWith(TESTS)) tests += hits
      else callers += hits
    }
    rows.push({ fn, file: f.slice(SRC.length + 1), callers, tests })
  }
}

const dead = rows.filter((r) => r.callers === 0)
console.log(`${rows.length} exported service functions · ${dead.length} with no caller outside their own file\n`)
for (const r of dead.sort((a, b) => b.tests - a.tests)) {
  console.log(`  ${r.fn.padEnd(28)} ${r.file.padEnd(44)} tests:${r.tests}`)
}
