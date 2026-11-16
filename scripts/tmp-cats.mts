import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rows = await p.expenseCategory.findMany({ select: { code: true, itcDefault: true, gstTreatment: true } })
console.log('CATS', rows.length)
for (const r of rows) console.log(' ', r.code, r.itcDefault, r.gstTreatment)
await p.$disconnect()
