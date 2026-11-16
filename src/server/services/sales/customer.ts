import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { countryName } from '@/lib/countries'
import { stateCodeFromGstin, resolveTaxMode, taxModeLabel } from '@/server/services/tax/tax-mode'

export interface CustomerInput {
  name: string
  contactPerson?: string
  email?: string
  phone?: string
  country?: string
  currency?: string
  stateCode?: string | null
  gstin?: string | null
  pan?: string | null
  customerType?: 'B2B' | 'B2C' | 'SEZ' | 'EXPORT'
  paymentTermDays?: number
  defaultTdsSection?: '194J' | '194C' | null
  billingAddress: Record<string, unknown>
}

/** GSTIN characters 1–2 are the state code; a mismatch is almost always a typo. */
function validate(input: CustomerInput) {
  const country = input.country ?? 'IN'

  if (country === 'IN' && input.gstin) {
    const fromGstin = stateCodeFromGstin(input.gstin)
    if (fromGstin && input.stateCode && fromGstin !== input.stateCode) {
      throw new AppError(
        `GSTIN ${input.gstin} belongs to state ${fromGstin}, but the state is set to ${input.stateCode}. One of them is wrong.`,
      )
    }
  }
  if (country === 'IN' && !input.stateCode) {
    throw new AppError('An Indian customer needs a state — it decides CGST+SGST versus IGST')
  }
  if (country !== 'IN' && input.gstin) {
    throw new AppError('An overseas customer cannot have a GSTIN')
  }
}

/**
 * 🔴 The billing address PRINTS on the invoice, so its `country` is a name, not a code.
 *
 * Normalised here rather than in the form action, because the service is the boundary: the
 * action was already doing it and a second caller would not have. Found by rendering an
 * invoice to a Dubai client and reading the address block, which ended "AE".
 */
export function printableAddress(address: unknown, country: string) {
  const a = (address ?? {}) as Record<string, unknown>
  const stored = String(a.country ?? '').trim()
  return { ...a, country: countryName(stored || country) || stored }
}

export async function createCustomer(ctx: RequestContext, input: CustomerInput) {
  assertCan(ctx.role, 'customers', 'write')
  validate(input)

  const customer = await prisma.customer.create({
    data: {
      companyId: ctx.companyId,
      name: input.name.trim(),
      contactPerson: input.contactPerson,
      email: input.email,
      phone: input.phone,
      country: input.country ?? 'IN',
      stateCode: input.stateCode ?? stateCodeFromGstin(input.gstin),
      gstin: input.gstin || null,
      pan: input.pan || null,
      customerType: input.customerType ?? ((input.country ?? 'IN') === 'IN' ? 'B2B' : 'EXPORT'),
      // 🔴 Only meaningful for an export: `invoiceCurrency` forces INR on a domestic
      // invoice whatever is stored here. Written so it can no longer be USD by default
      // for a client who agreed on something else.
      currency: (input.currency || 'USD').toUpperCase(),
      paymentTermDays: input.paymentTermDays ?? 15,
      defaultTdsSection: input.defaultTdsSection ?? null,
      billingAddress: printableAddress(input.billingAddress, input.country ?? 'IN') as never,
    },
  })
  await audit(ctx, { entity: 'Customer', entityId: customer.id, action: 'CREATE', after: { name: customer.name } })
  return customer
}

export async function updateCustomer(ctx: RequestContext, id: string, input: CustomerInput) {
  assertCan(ctx.role, 'customers', 'write')
  validate(input)
  const existing = await prisma.customer.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!existing) throw new NotFound('Customer not found')

  const customer = await prisma.customer.update({
    where: { companyId: ctx.companyId, id },
    data: {
      name: input.name.trim(),
      contactPerson: input.contactPerson,
      email: input.email,
      phone: input.phone,
      country: input.country ?? 'IN',
      stateCode: input.stateCode ?? stateCodeFromGstin(input.gstin),
      gstin: input.gstin || null,
      pan: input.pan || null,
      customerType: input.customerType ?? existing.customerType,
      currency: (input.currency || existing.currency).toUpperCase(),
      paymentTermDays: input.paymentTermDays ?? existing.paymentTermDays,
      defaultTdsSection: input.defaultTdsSection ?? null,
      billingAddress: printableAddress(input.billingAddress, input.country ?? 'IN') as never,
    },
  })
  // 🔴 Record the TAX-RELEVANT fields, not just the name. A changed state code or GSTIN
  // alters how every future invoice to this customer is taxed — CGST+SGST becomes IGST —
  // and "who changed it, when, from what" is the only way to explain a period where the
  // treatment switched.
  await audit(ctx, {
    entity: 'Customer', entityId: id, action: 'UPDATE',
    before: { name: existing.name, gstin: existing.gstin, stateCode: existing.stateCode, country: existing.country, currency: existing.currency, billingAddress: existing.billingAddress },
    after: { name: customer.name, gstin: customer.gstin, stateCode: customer.stateCode, country: customer.country, currency: customer.currency, billingAddress: customer.billingAddress },
  })
  return customer
}

/** What tax treatment this customer will attract — shown on the customer form. */
export async function taxPreviewFor(companyId: string, customerId: string) {
  const [company, customer] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { stateCode: true } }),
    prisma.customer.findFirstOrThrow({ where: { id: customerId, companyId } }),
  ])
  const mode = resolveTaxMode(
    { stateCode: company.stateCode },
    { country: customer.country, stateCode: customer.stateCode, customerType: customer.customerType },
  )
  return { mode, label: taxModeLabel(mode) }
}

export async function listCustomers(ctx: RequestContext) {
  assertCan(ctx.role, 'customers', 'read')
  return prisma.customer.findMany({
    where: { companyId: ctx.companyId, isActive: true },
    orderBy: { name: 'asc' },
    include: { _count: { select: { invoices: true, projects: true } } },
  })
}
