import { PrismaClient } from '@prisma/client'
import { arSummary } from '../src/server/services/sales/receivables'
import { receivablesAgeing } from '../src/server/services/reports/ageing'
import { trialBalance, balanceSheet } from '../src/server/services/reports/statements'
const prisma = new PrismaClient()
const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
const user = await prisma.user.findFirstOrThrow()
const ctx = { userId: user.id, companyId: company.id, role: 'OWNER' as const }
const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })

const ar = await arSummary(ctx)
const ag = await receivablesAgeing(ctx)
console.log('CHECK arSummary.total   ', ar.total.toFixed(2))
console.log('CHECK ageing.grandTotal ', ag.grandTotal.toFixed(2))
console.log('CHECK agree             ', ar.total.minus(ag.grandTotal).abs().lte('0.5'))

const tb = await trialBalance(ctx, { from: fy.startsOn, to: fy.endsOn })
console.log('CHECK trialBalance balanced', tb.balanced, tb.difference.toFixed(2))
const bs = await balanceSheet(ctx, fy.endsOn, fy.startsOn)
console.log('CHECK balanceSheet balanced', bs.balanced, bs.difference.toFixed(2))
await prisma.$disconnect()
