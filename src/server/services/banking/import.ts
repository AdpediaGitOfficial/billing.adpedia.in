import { prisma } from '@/server/db'
import { Decimal } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { parseStatement, AXIS_PROFILE, HDFC_PROFILE, type BankProfileSpec } from './parse'

export const PROFILES: Record<string, BankProfileSpec> = {
  AXIS: AXIS_PROFILE,
  HDFC: HDFC_PROFILE,
}

export interface ImportResult {
  importId: string
  imported: number
  duplicates: number
  skipped: { row: number; reason: string; raw: string }[]
  balanceCheck: { ok: boolean; expected: string | null; actual: string | null; difference: string | null }
  periodFrom: Date | null
  periodTo: Date | null
}

/**
 * 🔴 The balance check gates the import.
 *
 * If opening ± Σ(credits − debits) ≠ closing, the file was read wrong — and a
 * mis-parsed statement is far worse than no statement, because every figure after it
 * looks authoritative. The batch is refused outright unless the caller overrides
 * deliberately (docs/02 §H2).
 */
export async function importStatement(ctx: RequestContext, input: {
  bankAccountId: string
  profileKey: keyof typeof PROFILES
  text: string
  fileName?: string
  openingBalance?: string
  closingBalance?: string
  force?: boolean
}): Promise<ImportResult> {
  assertCan(ctx.role, 'banking', 'write')

  const bank = await prisma.companyBankAccount.findFirst({ where: { id: input.bankAccountId, companyId: ctx.companyId } })
  if (!bank) throw new AppError('Bank account not found')

  const profile = PROFILES[input.profileKey]
  if (!profile) throw new AppError(`No parser profile for ${input.profileKey}`)

  const parsed = parseStatement(input.text, profile, bank.id, {
    openingBalance: input.openingBalance, closingBalance: input.closingBalance,
  })

  if (parsed.transactions.length === 0) {
    throw new AppError(
      parsed.skipped[0]?.reason ?? 'No transactions found in that file. Export it from internet banking as CSV rather than PDF — the PDF text layer interleaves columns.',
    )
  }

  if (!parsed.balanceCheck.ok && !input.force) {
    const d = parsed.balanceCheck
    throw new AppError(
      d.difference
        ? `Balance check failed: opening plus the movement comes to ₹${d.expected?.toFixed(2)} but the statement closes at ₹${d.actual?.toFixed(2)} — a difference of ₹${d.difference.abs().toFixed(2)}. The file was read wrong; importing it would put wrong figures into the ledger. Check the opening and closing balances, or re-export as CSV.`
        : 'Balance check could not run — the opening or closing balance was not found. Enter them manually, or import anyway if you are certain.',
    )
  }

  const record = await prisma.bankStatementImport.create({
    data: {
      companyId: ctx.companyId, bankAccountId: bank.id,
      fileName: input.fileName ?? 'pasted',
      format: 'CSV',
      periodFrom: parsed.periodFrom ?? new Date(),
      periodTo: parsed.periodTo ?? new Date(),
      openingBalance: (parsed.openingBalance ?? new Decimal(0)).toFixed(2),
      closingBalance: (parsed.closingBalance ?? new Decimal(0)).toFixed(2),
      balanceCheckOk: parsed.balanceCheck.ok,
    },
  })

  let imported = 0, duplicates = 0
  for (const t of parsed.transactions) {
    // the unique dedupeHash makes a double import impossible rather than merely unlikely
    const existing = await prisma.bankTransaction.findUnique({ where: { dedupeHash: t.dedupeHash } })
    if (existing) { duplicates++; continue }
    await prisma.bankTransaction.create({
      data: {
        companyId: ctx.companyId, bankAccountId: bank.id, importId: record.id,
        txnDate: t.txnDate, valueDate: t.valueDate,
        amount: t.amount.toFixed(2), direction: t.direction,
        rawNarration: t.rawNarration, refNo: t.utr, utr: t.utr, chequeNo: t.chequeNo,
        runningBalance: t.runningBalance?.toFixed(2),
        dedupeHash: t.dedupeHash,
        counterpartyGuess: t.counterparty,
        status: 'UNMATCHED',
      },
    })
    imported++
  }

  await prisma.bankStatementImport.update({
    where: { id: record.id }, data: { rowsImported: imported, rowsDuplicate: duplicates },
  })
  await audit(ctx, { entity: 'BankStatementImport', entityId: record.id, action: 'CREATE', after: { imported, duplicates } })

  return {
    importId: record.id, imported, duplicates, skipped: parsed.skipped,
    balanceCheck: {
      ok: parsed.balanceCheck.ok,
      expected: parsed.balanceCheck.expected?.toFixed(2) ?? null,
      actual: parsed.balanceCheck.actual?.toFixed(2) ?? null,
      difference: parsed.balanceCheck.difference?.toFixed(2) ?? null,
    },
    periodFrom: parsed.periodFrom, periodTo: parsed.periodTo,
  }
}
