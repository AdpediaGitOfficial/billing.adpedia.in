/**
 * The 4th character of an Indian PAN encodes the holder's entity type.
 * It is what decides the 194C rate — 1% for an individual or HUF, 2% for a
 * company or firm — so it is derived rather than asked for and got wrong.
 */
export type PanEntity = 'INDIVIDUAL' | 'HUF' | 'COMPANY' | 'FIRM' | 'AOP' | 'TRUST' | 'BODY' | 'GOVT' | 'LOCAL' | 'ARTIFICIAL' | 'UNKNOWN'

const MAP: Record<string, PanEntity> = {
  P: 'INDIVIDUAL', H: 'HUF', C: 'COMPANY', F: 'FIRM', A: 'AOP', T: 'TRUST',
  B: 'BODY', G: 'GOVT', L: 'LOCAL', J: 'ARTIFICIAL',
}

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

export function isValidPanFormat(pan: string | null | undefined): boolean {
  return !!pan && PAN_RE.test(pan.trim().toUpperCase())
}

export function panEntity(pan: string | null | undefined): PanEntity {
  if (!isValidPanFormat(pan)) return 'UNKNOWN'
  return MAP[pan!.trim().toUpperCase()[3]] ?? 'UNKNOWN'
}

/** 194C splits on this: companies and firms pay 2%, individuals and HUFs 1%. */
export function isCompanyOrFirm(pan: string | null | undefined): boolean {
  const e = panEntity(pan)
  return e === 'COMPANY' || e === 'FIRM' || e === 'AOP' || e === 'BODY' || e === 'TRUST' || e === 'LOCAL'
}

export function panEntityLabel(pan: string | null | undefined): string {
  const map: Record<PanEntity, string> = {
    INDIVIDUAL: 'Individual', HUF: 'HUF', COMPANY: 'Company', FIRM: 'Firm / LLP',
    AOP: 'Association of persons', TRUST: 'Trust', BODY: 'Body of individuals',
    GOVT: 'Government', LOCAL: 'Local authority', ARTIFICIAL: 'Artificial juridical person',
    UNKNOWN: 'Unknown',
  }
  return map[panEntity(pan)]
}
