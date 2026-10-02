'use client'
import { createVendorAction } from '../actions'
import { VendorForm } from '../vendor-form'

export default function NewVendorPage() {
  return (
    <VendorForm
      action={createVendorAction}
      title="New vendor"
      sub="Reverse charge and the TDS rate are derived from what you enter — neither is chosen by hand."
      submitLabel="Save vendor" />
  )
}
