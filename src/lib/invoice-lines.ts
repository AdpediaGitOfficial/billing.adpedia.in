/**
 * The rules an invoice form applies to its lines before they leave the browser.
 *
 * 🔴 docs/88. The form had no GST-rate field and started every line at a hidden `18`. For an
 * entity that may not collect GST, `assertMayChargeGst` read that 18 and refused — before the
 * export rule or the tax mode could zero it — so a personal account could not save a single
 * invoice, and the message said "set the rate to 0" about a field that did not exist.
 *
 * Kept out of the component so it can be tested without a browser, and so a second form
 * (draft editing reuses the first) cannot invent its own default.
 */
export interface FormLine {
  description: string
  sacCode: string
  quantity: string
  rate: string
  gstRatePct: string
  serviceItemId?: string | null
}

/** What GST rate a new line starts at: the usual 18 for an entity that charges it, 0 for one that may not. */
export function defaultGstRate(canChargeGst: boolean): string {
  return canChargeGst ? '18' : '0'
}

export function blankLine(canChargeGst: boolean): FormLine {
  return {
    description: '', sacCode: '', quantity: '1', rate: '',
    gstRatePct: defaultGstRate(canChargeGst), serviceItemId: null,
  }
}

/**
 * The GST rule applied to the lines. For an entity that may not charge GST every line goes at
 * 0, whatever it was opened with — a draft saved under another rule must not be stranded
 * behind a refusal the person has no field to answer.
 */
export function withGstRule(lines: readonly FormLine[], canChargeGst: boolean): FormLine[] {
  return lines.map((l) => (canChargeGst ? l : { ...l, gstRatePct: '0' }))
}

/** What is saved: the rule above, and only the lines that actually say something. */
export function linesToSend(lines: readonly FormLine[], canChargeGst: boolean): FormLine[] {
  return withGstRule(lines, canChargeGst).filter((l) => l.description && l.rate)
}
