import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader, Alert } from '@/components/ui/kit'
import { mayCollectTax } from '@/server/services/invoicing/document-type'
import { InvoiceForm } from '../../new/form'
import { updateInvoiceAction } from '../../actions'

/**
 * Editing a draft — docs/70.
 *
 * The same form as `/invoices/new`, because it is the same document at the same stage: a
 * draft carries no number, posts nothing and has been shown to nobody. A second form would be
 * a second place for the SAC check, the tax-mode preview and the service-item binding to
 * drift apart.
 */
export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const invoice = await prisma.invoice.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { lines: { orderBy: { position: 'asc' } } },
  })
  if (!invoice) notFound()

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { gstRegistrationType: true },
  })
  const [customers, projects, items] = await Promise.all([
    prisma.customer.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: 'asc' },
      select: { id: true, name: true, country: true, stateCode: true, defaultTdsSection: true } }),
    prisma.project.findMany({ where: { companyId: ctx.companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' },
      select: { id: true, name: true, customerId: true } }),
    prisma.serviceItem.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: 'asc' },
      select: { id: true, name: true, sacCode: true, defaultRate: true } }),
  ])

  /**
   * 🔴 The refusal is the service's, and it is shown rather than hidden. Reaching this page
   * for an issued invoice is a stale link or a typed URL, and "not found" would be a lie — it
   * exists, and what it cannot be is edited.
   */
  if (invoice.status !== 'DRAFT') {
    return (
      <div className="max-w-3xl space-y-5">
        <PageHeader title={invoice.number} sub="Issued — and therefore fixed"
          back={{ href: `/invoices/${invoice.id}`, label: `Invoice ${invoice.number ?? ''}`.trim() }} />
        <Alert tone="critical" title={`${invoice.number} has been sent`}>
          An issued invoice is frozen: the client has it, its number is in the series and its figures are in a
          return. Raise a credit or debit note against it, or cancel it and raise a new one.
        </Alert>
      </div>
    )
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Edit draft"
        sub="Nothing has been posted and no number has been allocated — this draft exists only here." />
      <InvoiceForm
        canChargeGst={mayCollectTax(company.gstRegistrationType)}
        customers={customers}
        projects={projects}
        items={items.map((i) => ({ ...i, defaultRate: i.defaultRate?.toString() ?? null }))}
        submit={updateInvoiceAction.bind(null, invoice.id)}
        backHref={`/invoices/${invoice.id}`}
        draft={{
          customerId: invoice.customerId,
          projectId: invoice.projectId ?? '',
          date: invoice.date.toISOString().slice(0, 10),
          customerRef: invoice.customerRef ?? '',
          milestone: invoice.milestone ?? '',
          tdsSection: invoice.tdsSection ?? '',
          // the default 1 is "not entered yet" for a foreign invoice, so it is not shown as a rate
          fxRate: invoice.currency !== 'INR' && !invoice.fxRate.eq(1) ? invoice.fxRate.toString() : '',
          lines: invoice.lines.map((l) => ({
            description: l.description,
            sacCode: l.sacCode ?? '',
            quantity: l.quantity.toString(),
            rate: l.rate.toString(),
            gstRatePct: l.gstRatePct.toString(),
            serviceItemId: l.serviceItemId,
          })),
        }}
      />
    </div>
  )
}
