import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { isValidPanFormat, panEntityLabel } from '@/server/services/tax/pan'
import type { VendorType } from '@prisma/client'

export interface VendorInput {
  name: string
  vendorType: VendorType
  email?: string
  phone?: string
  country?: string
  stateCode?: string | null
  gstin?: string | null
  pan?: string | null
  defaultTdsSection?: string | null
  paymentTermDays?: number
  address?: Record<string, unknown>
}

/**
 * A vendor without an Indian GSTIN is an import of service: Adpedia self-accounts IGST
 * under reverse charge, pays it in cash and claims it back as ITC. Live for
 * DigitalOcean and Afrizon Crenergy Trade Pte (docs/04 §2).
 */
export function deriveRcm(country: string, gstin: string | null | undefined) {
  const isForeignSupplier = country !== 'IN'
  return { isForeignSupplier, rcmApplicable: isForeignSupplier && !gstin }
}

function validate(input: VendorInput) {
  const country = input.country ?? 'IN'
  if (input.pan && !isValidPanFormat(input.pan)) {
    throw new AppError(`"${input.pan}" is not a valid PAN — expected five letters, four digits, one letter.`)
  }
  if (country !== 'IN' && input.gstin) throw new AppError('An overseas vendor cannot have an Indian GSTIN')
  if (country === 'IN' && input.defaultTdsSection === '195') {
    throw new AppError('Section 195 applies to payments to non-residents only')
  }
  if (country !== 'IN' && input.defaultTdsSection && input.defaultTdsSection !== '195') {
    throw new AppError(`A non-resident vendor is deducted under s.195, not ${input.defaultTdsSection}`)
  }
}

export async function createVendor(ctx: RequestContext, input: VendorInput) {
  assertCan(ctx.role, 'vendors', 'write')
  validate(input)
  const country = input.country ?? 'IN'
  const rcm = deriveRcm(country, input.gstin)

  const vendor = await prisma.vendor.create({
    data: {
      companyId: ctx.companyId,
      name: input.name.trim(),
      vendorType: input.vendorType,
      email: input.email, phone: input.phone,
      country, stateCode: input.stateCode ?? null,
      gstin: input.gstin || null,
      pan: input.pan ? input.pan.trim().toUpperCase() : null,
      panVerified: !!input.pan && isValidPanFormat(input.pan),
      defaultTdsSection: input.defaultTdsSection || null,
      paymentTermDays: input.paymentTermDays ?? 15,
      address: (input.address ?? {}) as never,
      ...rcm,
    },
  })
  await audit(ctx, { entity: 'Vendor', entityId: vendor.id, action: 'CREATE', after: { name: vendor.name, rcm: rcm.rcmApplicable } })
  return vendor
}

export async function updateVendor(ctx: RequestContext, id: string, input: VendorInput) {
  assertCan(ctx.role, 'vendors', 'write')
  validate(input)
  const existing = await prisma.vendor.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!existing) throw new NotFound('Vendor not found')

  const country = input.country ?? 'IN'
  const vendor = await prisma.vendor.update({
    where: { id },
    data: {
      name: input.name.trim(), vendorType: input.vendorType,
      email: input.email, phone: input.phone,
      country, stateCode: input.stateCode ?? null,
      gstin: input.gstin || null,
      pan: input.pan ? input.pan.trim().toUpperCase() : null,
      panVerified: !!input.pan && isValidPanFormat(input.pan),
      defaultTdsSection: input.defaultTdsSection || null,
      paymentTermDays: input.paymentTermDays ?? existing.paymentTermDays,
      address: (input.address ?? existing.address ?? {}) as never,
      ...deriveRcm(country, input.gstin),
    },
  })
  // 🔴 PAN and the foreign-supplier flag decide the TDS rate and whether reverse charge
  // applies. A change to either rewrites how future bills are taxed, so the audit records
  // what it was as well as what it became.
  await audit(ctx, {
    entity: 'Vendor', entityId: id, action: 'UPDATE',
    before: { name: existing.name, pan: existing.pan, isForeignSupplier: existing.isForeignSupplier, defaultTdsSection: existing.defaultTdsSection },
    after: { name: vendor.name, pan: vendor.pan, isForeignSupplier: vendor.isForeignSupplier, defaultTdsSection: vendor.defaultTdsSection },
  })
  return vendor
}

export async function listVendors(ctx: RequestContext) {
  assertCan(ctx.role, 'vendors', 'read')
  const vendors = await prisma.vendor.findMany({
    where: { companyId: ctx.companyId, isActive: true },
    orderBy: { name: 'asc' },
    include: { _count: { select: { bills: true } } },
  })
  return vendors.map((v) => ({ ...v, entityLabel: panEntityLabel(v.pan) }))
}
