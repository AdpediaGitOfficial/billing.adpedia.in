/**
 * The GST state codes, in full.
 *
 * 🔴 This table already existed, in `server/services/tax/tax-mode.ts`, complete and
 * correct — and four client forms each wrote out their own seven or twelve of it, so a
 * client in Rajasthan could not be entered and the GSTR-1 amendment form could not
 * correct a place of supply to a state it did not happen to list. The knowledge was in
 * the repository; it was not in the place that needed it.
 *
 * It lives in `lib` rather than under `server` because the forms that need it are client
 * components, and nothing here may drag a server module into the browser bundle.
 *
 * The code is the first two characters of a GSTIN and decides CGST+SGST versus IGST,
 * so it is stored, never the name.
 */
export const STATE_NAMES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '96': 'Other Country', '97': 'Other Territory',
}

/**
 * What a form offers, in code order. 96 and 97 are excluded: they are reporting buckets
 * for GSTR-1, not places a customer or vendor is registered in.
 */
export const STATE_OPTIONS: readonly { code: string; name: string }[] =
  Object.entries(STATE_NAMES)
    .filter(([code]) => code !== '96' && code !== '97')
    .map(([code, name]) => ({ code, name }))

export function stateName(code: string | null | undefined): string {
  if (!code) return '—'
  return STATE_NAMES[code] ?? `State ${code}`
}
