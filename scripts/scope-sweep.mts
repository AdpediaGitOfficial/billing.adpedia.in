/**
 * docs/82 §1, docs/95 — a report of every query on a company-scoped model with no company filter.
 *
 * The logic lives in tests/helpers/scope-sweep.ts and is enforced by tests/scope-sweep.test.ts,
 * which fails the build on a new one. This prints them, for reading.
 *
 *   npx tsx scripts/scope-sweep.mts
 */
import { sweep, scopedModels } from '../tests/helpers/scope-sweep'

const offenders = sweep()
console.log(`scoped models in the schema: ${scopedModels().size}`)
console.log(`queries with no company filter: ${offenders.length}\n`)
for (const o of offenders) console.log(`  ${o.file}:${o.line}  ${o.model}.${o.op}\n      ${o.text}`)
