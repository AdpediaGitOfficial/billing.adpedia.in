import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Alert } from '@/components/ui/kit'
import { updateVendorAction } from '../../actions'
import { VendorForm } from '../../vendor-form'

/**
 * Editing a vendor — docs/49.
 *
 * `updateVendor` has existed since docs/41, with its audit trail recording what the PAN and
 * the foreign-supplier flag were before and after, and no page could call it. A vendor whose
 * GSTIN arrived later, or whose TDS section was wrong, could only be fixed in the database.
 */
export default async function EditVendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const vendor = await prisma.vendor.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!vendor) notFound()

  const bills = await prisma.vendorBill.count({
    where: { vendorId: vendor.id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
  })

  return (
    <div className="max-w-2xl space-y-4">
      {bills > 0 && (
        /* 🔴 Bills already raised keep their own figures. The TDS on them was computed when
           they were approved and posted; changing the section or the PAN here governs what
           happens NEXT, exactly as docs/41 decided for invoices. */
        <Alert tone="warn" title={`${bills} bill${bills === 1 ? '' : 's'} already posted against this vendor`}>
          Changing the PAN, the TDS section or the country affects <strong>future</strong> bills only.
          What was already deducted stays as it was deducted — it has been reported, and a bill that
          quietly re-rated itself would no longer agree with the return that carried it.
        </Alert>
      )}

      <VendorForm
        action={updateVendorAction}
        title={`Edit ${vendor.name}`}
        sub="Reverse charge and the TDS rate are derived from what you enter — neither is chosen by hand."
        submitLabel="Save changes"
        initial={{
          id: vendor.id,
          name: vendor.name,
          vendorType: vendor.vendorType,
          country: vendor.country,
          stateCode: vendor.stateCode,
          gstin: vendor.gstin,
          pan: vendor.pan,
          defaultTdsSection: vendor.defaultTdsSection,
          email: vendor.email,
          paymentTermDays: vendor.paymentTermDays,
        }} />
    </div>
  )
}
