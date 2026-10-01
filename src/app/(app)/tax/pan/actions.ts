'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { savePans, parsePanPaste, matchByName, type PartyKind } from '@/server/services/tax/pan-register'

export async function savePanForm(_prev: unknown, form: FormData) {
  const ctx = await requireContext()
  const assignments = [...form.entries()]
    .filter(([k, v]) => k.startsWith('pan:') && String(v).trim())
    .map(([k, v]) => {
      const [, kind, id] = k.split(':')
      return { kind: kind as PartyKind, id, pan: String(v) }
    })

  if (assignments.length === 0) return { ok: false, message: 'Nothing to save' }
  const res = await savePans(ctx, assignments)
  revalidatePath('/tax/pan')
  return {
    ok: res.rejected.length === 0,
    message: res.rejected.length === 0
      ? `Saved ${res.saved} PAN${res.saved === 1 ? '' : 's'}.`
      : `Saved ${res.saved}. Rejected: ${res.rejected.map((r) => `${r.name} — ${r.reason}`).join('; ')}`,
  }
}

/** Paste a list, match it by name, save what matches and report what did not. */
export async function pastePans(_prev: unknown, form: FormData) {
  const ctx = await requireContext()
  const text = String(form.get('paste') ?? '')
  const parsed = parsePanPaste(text)
  if (parsed.length === 0) {
    return { ok: false, message: 'No PANs found in that. Each line needs a name and a PAN.' }
  }

  const [employees, vendors] = await Promise.all([
    prisma.employee.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true } }),
    prisma.vendor.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true } }),
  ])

  const emp = matchByName(parsed, employees)
  const ven = matchByName(emp.unmatched, vendors)

  const assignments = [
    ...emp.matched.map((m) => ({ kind: 'EMPLOYEE' as PartyKind, id: m.person.id, pan: m.pan })),
    ...ven.matched.map((m) => ({ kind: 'VENDOR' as PartyKind, id: m.person.id, pan: m.pan })),
  ]
  const res = await savePans(ctx, assignments)
  revalidatePath('/tax/pan')

  const parts = [`Matched and saved ${res.saved} of ${parsed.length}.`]
  if (ven.unmatched.length > 0) {
    parts.push(`No one on file matches: ${ven.unmatched.map((u) => u.name).join(', ')}.`)
  }
  if (res.rejected.length > 0) {
    parts.push(`Rejected: ${res.rejected.map((r) => `${r.name} — ${r.reason}`).join('; ')}`)
  }
  return { ok: ven.unmatched.length === 0 && res.rejected.length === 0, message: parts.join(' ') }
}
