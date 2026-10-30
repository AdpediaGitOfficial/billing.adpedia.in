import type { Constitution, DocType, GstRegType } from '@prisma/client'
import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { AppError } from '@/server/errors'
import { audit } from '@/server/audit'
import { seedAccounts } from './chart'
import { seedExpenseCategories } from './categories'
import { isValidPanFormat, panEntity, panEntityLabel, type PanEntity } from '@/server/services/tax/pan'
import { stateCodeFromGstin } from '@/server/services/tax/tax-mode'
import { renderPattern, validateInvoiceNumber } from '@/server/services/invoicing/numbering'
import { fyLabelFor, fyBounds, shortFy } from '@/lib/fy'

/**
 * Bringing a second entity into being — docs/82 §2.
 *
 * Until now the only Company row in existence came from the seed, which hardcodes Adpedia's
 * own legal name, PAN, GSTIN and address. A second entity is not a variant of the first: it is
 * a different legal person, with its own PAN, its own returns and its own taxpayer, and
 * nothing is ever consolidated between them.
 *
 * 🔴 A company is born COMPLETE or not at all. Without a chart of accounts nothing can post;
 * without a financial year nothing can be dated; without a document series `allocateNumber`
 * refuses and points at a Settings screen that does not exist (docs/65 §6). All of it happens
 * in one transaction, so a half-born entity cannot be left behind for somebody to discover
 * when they try to raise its first invoice.
 */

export interface CreateCompanyInput {
  legalName: string
  tradeName?: string
  constitution: Constitution
  pan: string
  /** omitted for an unregistered entity — see the registration check below */
  gstin?: string | null
  tan?: string | null
  gstRegistrationType?: GstRegType
  /** drives CGST+SGST vs IGST on every document this entity raises */
  stateCode: string
  /** rule 46(c) — the supplier's address prints on every invoice, so line 1 is required */
  address: {
    line1: string
    line2?: string
    city?: string
    state?: string
    pincode?: string
    country?: string
  }
  /** 2–4 letters. The document series are built from it — Rule 46 caps a number at 16 chars */
  seriesPrefix: string
  /** what GL 1010 is called here, e.g. "Axis Bank — Current 9210…" */
  bankLabel?: string
  /** who signs this entity's documents — "Shinelal C P" — and as what — "Managing Partner" */
  signatoryName?: string
  signatoryDesignation?: string
  fyStartMonth?: number
}

/**
 * 🔴 The 4th character of a PAN is the registrar's own statement of what the holder IS.
 *
 * A proprietorship entered against a PAN whose 4th character is `C` is not a typo to be
 * tolerated: either the constitution is wrong or the PAN belongs to somebody else, and both
 * put this entity's income in the wrong return — the company's instead of the proprietor's, or
 * the reverse. It is also what decides 194C at 1% versus 2%, so it is derived everywhere else
 * in this system rather than asked for and got wrong (docs/47).
 */
const PAN_ENTITY_FOR: Record<Constitution, PanEntity> = {
  PRIVATE_LIMITED: 'COMPANY',
  PUBLIC_LIMITED: 'COMPANY',
  LLP: 'FIRM',
  PARTNERSHIP: 'FIRM',
  PROPRIETORSHIP: 'INDIVIDUAL',
}

/** The series a new entity needs on day one, suffixed off its own prefix. */
const SERIES: ReadonlyArray<readonly [DocType, string]> = [
  ['TAX_INVOICE', ''],
  // 🔴 docs/82 §5 — an unregistered entity issues this INSTEAD of a tax invoice. Created for
  // every entity so a later registration change does not need a backfill migration.
  ['BILL_OF_SUPPLY', 'B'],
  ['EXPORT_INVOICE', 'X'],
  ['CREDIT_NOTE', 'C'],
  ['DEBIT_NOTE', 'D'],
  ['RECEIPT', 'R'],
  ['SELF_INVOICE', 'S'],
  ['PROFORMA', 'P'],
  ['REFUND_VOUCHER', 'F'],
] as const

export async function createCompany(ctx: RequestContext, input: CreateCompanyInput) {
  // 🔴 OWNER only — `settings.company` carries write for no other role. Creating a legal
  // entity is not an editing permission.
  assertCan(ctx.role, 'settings.company', 'write')

  const legalName = input.legalName.trim()
  if (legalName.length < 3) throw new AppError('The legal name is required, exactly as registered')

  const pan = input.pan.trim().toUpperCase()
  if (!isValidPanFormat(pan)) {
    throw new AppError('That is not a valid PAN — five letters, four digits, one letter')
  }

  const expected = PAN_ENTITY_FOR[input.constitution]
  if (panEntity(pan) !== expected) {
    throw new AppError(
      `PAN ${pan} is registered to ${panEntityLabel(pan).toLowerCase()}, which does not match ` +
      `a ${input.constitution.replace('_', ' ').toLowerCase()}. Either the constitution or the PAN is wrong — ` +
      'the fourth character decides whose return this entity\'s income belongs in.',
    )
  }

  const stateCode = input.stateCode.trim()
  if (!/^\d{2}$/.test(stateCode)) throw new AppError('The state code is two digits — 32 for Kerala')

  const gstin = input.gstin?.trim().toUpperCase() || null
  const registration = input.gstRegistrationType ?? (gstin ? 'REGULAR' : 'UNREGISTERED')

  /**
   * 🔴 The registration type and the GSTIN must agree, and nothing in this system checked
   * that before — `gstRegistrationType` was a field nothing read (docs/82 §5). An entity
   * marked REGULAR with no GSTIN cannot raise a compliant invoice; one marked UNREGISTERED
   * with a GSTIN is being told to behave two ways at once.
   */
  if (registration === 'UNREGISTERED' && gstin) {
    throw new AppError('An unregistered entity has no GSTIN. Remove it, or set the registration type.')
  }
  if (registration !== 'UNREGISTERED' && !gstin) {
    throw new AppError('A registered entity needs its GSTIN — it is printed on every invoice it raises')
  }
  if (gstin) {
    if (gstin.length !== 15) throw new AppError('A GSTIN is 15 characters')
    if (stateCodeFromGstin(gstin) !== stateCode) {
      throw new AppError(
        `GSTIN ${gstin} begins with ${stateCodeFromGstin(gstin)}, which is not state ${stateCode}. ` +
        'The first two characters of a GSTIN are the state, and the state decides CGST+SGST versus IGST.',
      )
    }
    if (gstin.slice(2, 12) !== pan) {
      throw new AppError(`GSTIN ${gstin} does not carry PAN ${pan} — characters 3 to 12 of a GSTIN are the PAN`)
    }
  }

  // rule 46(c), as `profile.ts` enforces it on edit
  if (!input.address.line1?.trim()) {
    throw new AppError('The registered address needs at least a first line — it prints on every invoice')
  }
  if (input.address.pincode && !/^\d{6}$/.test(input.address.pincode.trim())) {
    throw new AppError(`"${input.address.pincode}" is not a pincode — six digits`)
  }

  const prefix = input.seriesPrefix.trim().toUpperCase()
  if (!/^[A-Z]{2,4}$/.test(prefix)) {
    throw new AppError('The series prefix is 2 to 4 letters, e.g. ADP — it opens every document number')
  }

  const fyStartMonth = input.fyStartMonth ?? 4
  const label = fyLabelFor(new Date(), fyStartMonth)
  const { startsOn, endsOn } = fyBounds(label)

  /**
   * 🔴 Every series is checked against Rule 46 BEFORE the company exists, at the highest
   * sequence it will ever render. A prefix that is fine at 0001 and seventeen characters at
   * 9999 would otherwise fail in the middle of a financial year, with numbers already issued
   * against it and no way to renumber them.
   */
  for (const [docType, suffix] of SERIES) {
    const pattern = `${prefix}${suffix}/{FY}/{SEQ:4}`
    const sample = renderPattern(pattern, { FY: shortFy(label), SEQ: 9999 })
    const check = validateInvoiceNumber(sample)
    if (!check.ok) throw new AppError(`Series ${docType}: ${check.reason}`)
  }

  /**
   * 🔴 Postgres treats NULLs as distinct in a unique index, so `@@unique([pan, gstin])` does
   * NOT stop two unregistered entities sharing a PAN — and two unregistered businesses on one
   * PAN are one taxpayer, filing one return. The database cannot refuse it, so this does.
   */
  const existing = await prisma.company.findFirst({ where: { pan, gstin } })
  if (existing) {
    throw new AppError(
      gstin
        ? `${existing.legalName} is already here with PAN ${pan} and GSTIN ${gstin}`
        : `${existing.legalName} already uses PAN ${pan} with no GSTIN — that is the same taxpayer`,
    )
  }

  const company = await prisma.$transaction(async (tx) => {
    const created = await tx.company.create({
      data: {
        legalName, tradeName: input.tradeName?.trim() || legalName,
        constitution: input.constitution,
        pan, gstin, tan: input.tan?.trim().toUpperCase() || null,
        gstRegistrationType: registration,
        stateCode,
        registeredAddress: {
          line1: input.address.line1.trim(),
          line2: input.address.line2?.trim() ?? '',
          city: input.address.city?.trim() ?? '',
          state: input.address.state?.trim() ?? '',
          stateCode,
          pincode: input.address.pincode?.trim() ?? '',
          country: input.address.country?.trim() || 'India',
        },
        currencyDefault: 'INR',
        fyStartMonth,
        signatoryName: input.signatoryName?.trim() || null,
        signatoryDesignation: input.signatoryDesignation?.trim() || null,
      },
    })

    await seedAccounts(tx, created.id, {
      constitution: input.constitution,
      bankLabel: input.bankLabel?.trim() || undefined,
    })
    await seedExpenseCategories(tx, created.id)

    const fy = await tx.financialYear.create({
      data: { companyId: created.id, label, startsOn, endsOn, status: 'OPEN' },
    })

    for (const [docType, suffix] of SERIES) {
      await tx.documentSeries.create({
        data: {
          companyId: created.id, financialYearId: fy.id,
          docType,
          prefix: `${prefix}${suffix}`,
          pattern: `${prefix}${suffix}/{FY}/{SEQ:4}`,
          nextSeq: 1,
        },
      })
    }

    /**
     * 🔴 The creator becomes OWNER of what they created, or nobody can reach it. The switcher
     * reads memberships (docs/82 §3), so an entity with no membership is invisible from every
     * screen — a company that exists and cannot be opened.
     */
    await tx.userCompany.create({
      data: { userId: ctx.userId, companyId: created.id, role: 'OWNER' },
    })

    // 🔴 audited under the NEW company, so its own trail opens with its creation rather than
    // the record living in whichever entity the creator happened to be signed in to.
    await audit({ userId: ctx.userId, companyId: created.id }, {
      entity: 'Company', entityId: created.id, action: 'CREATE',
      after: {
        legalName, constitution: input.constitution, pan, gstin,
        gstRegistrationType: registration, stateCode, financialYear: label, seriesPrefix: prefix,
      },
    }, tx)

    return created
  }, { timeout: 30_000 })

  return company
}
