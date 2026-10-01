import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const [j, i, c, a, s, l, u] = await Promise.all([
  p.journalEntry.count(), p.invoice.count(), p.customer.count(),
  p.account.count(), p.documentSeries.count(), p.companyLut.count(), p.user.count(),
])
const series = await p.documentSeries.findFirst({ where: { docType: 'TAX_INVOICE' } })
console.log(`journal entries ${j} · invoices ${i} · customers ${c}`)
console.log(`accounts ${a} · series ${s} · LUTs ${l} · users ${u}`)
console.log(`next invoice: ${series?.pattern.replace('{FY}', '26-27').replace(/\{SEQ:(\d+)\}/, (_, n) => String(series.nextSeq).padStart(Number(n), '0'))}`)
await p.$disconnect()
