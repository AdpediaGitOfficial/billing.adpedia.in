import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const sent = await p.invoice.findFirstOrThrow({ where: { status: { not: 'DRAFT' }, cancelledAt: null } })
const draft = await p.invoice.findFirstOrThrow({ where: { status: 'DRAFT' } })
const note = await p.creditNote.findFirstOrThrow()
const bill = await p.vendorBill.findFirstOrThrow({ where: { status: 'DRAFT' } })
const approved = await p.vendorBill.findFirstOrThrow({ where: { status: { not: 'DRAFT' } } })
const exp = await p.expense.findFirstOrThrow()
const cust = await p.customer.findFirstOrThrow()
const vend = await p.vendor.findFirstOrThrow()
const proj = await p.project.findFirstOrThrow()
const acct = await p.account.findFirstOrThrow({ where: { code: '1100' } })
console.log(JSON.stringify({
  sent: sent.id, draft: draft.id, note: note.id, bill: bill.id, approved: approved.id,
  exp: exp.id, cust: cust.id, vend: vend.id, proj: proj.id, acct: acct.code,
}))
await p.$disconnect()
