/**
 * SAC codes for the services Adpedia actually sells.
 *
 * ⚠️ PROVENANCE: these are the SAC codes under the GST Scheme of Classification of Services
 * (Notification 11/2017-CT(R), Annexure). They are stated to the best of my knowledge and
 * are NOT a CA's opinion. The one genuinely contested choice — how staff augmentation is
 * classified — is marked `needsConfirmation` and is explained below.
 *
 * 🔴 Why the code matters beyond the invoice: the SAC drives the **HSN/SAC summary in
 * GSTR-1**. A film billed under an IT code misstates the nature of the supply in the
 * return, not just on the document, and the return is what the department reads.
 */

export interface SacCode {
  code: string
  title: string
  /** what this actually covers, in the words a person would use */
  use: string
  gstRatePct: number
  /** 🔴 a judgement call the CA has to make, not a lookup */
  needsConfirmation?: string
}

export const SAC_CODES: SacCode[] = [
  // ── film and video production — group 9996 ──────────────────────────────────
  {
    code: '999612',
    title: 'Motion picture, videotape and television programme production services',
    use: 'Producing a brand film, ad film, TVC, corporate film or web series — concept, shoot and delivery.',
    gstRatePct: 18,
  },
  {
    code: '999613',
    title: 'Audiovisual post-production services',
    use: 'Edit, colour grade, VFX, motion graphics and animation done on footage — billed separately from the shoot.',
    gstRatePct: 18,
  },
  {
    code: '999611',
    title: 'Sound recording services',
    use: 'Voice-over, dubbing, mixing, sound design and music recording.',
    gstRatePct: 18,
  },
  {
    code: '999614',
    title: 'Motion picture, videotape and television programme distribution services',
    use: 'Licensing or distributing finished content, as opposed to making it.',
    gstRatePct: 18,
  },

  // ── advertising — group 99836 ───────────────────────────────────────────────
  {
    code: '998361',
    title: 'Advertising services',
    use: 'Campaign creative, concept and art direction — the agency fee itself, not the media buy.',
    gstRatePct: 18,
  },
  {
    code: '998365',
    title: 'Sale of internet advertising space',
    use: 'Reselling digital ad inventory on your own account.',
    gstRatePct: 18,
  },
  {
    code: '998362',
    title: 'Purchase or sale of advertising space or time, on commission',
    use: 'Media buying where you earn a commission rather than billing the spend.',
    gstRatePct: 18,
  },

  // ── photography and videography — group 99838 ───────────────────────────────
  {
    code: '998383',
    title: 'Event photography and event videography services',
    use: 'Covering an event — a launch, a conference, a wedding.',
    gstRatePct: 18,
  },
  {
    code: '998382',
    title: 'Advertising and related photography services',
    use: 'Product and campaign stills shot for advertising use.',
    gstRatePct: 18,
  },

  // ── IT and design — groups 99831 / 99839 ────────────────────────────────────
  {
    code: '998314',
    title: 'Information technology (IT) design and development services',
    use: 'Building a website or application and delivering the work product.',
    gstRatePct: 18,
  },
  {
    code: '998313',
    title: 'Information technology (IT) consulting and support services',
    use: 'Advisory, architecture review, ongoing technical support.',
    gstRatePct: 18,
  },
  {
    code: '998391',
    title: 'Specialty design services',
    use: 'Graphic design, UI/UX, brand identity and other specialty design.',
    gstRatePct: 18,
  },

  // ── manpower supply — group 99851 ───────────────────────────────────────────
  {
    code: '998513',
    title: 'Contract staffing services',
    use: 'Placing a resource to work under the CLIENT’s day-to-day direction for a period.',
    gstRatePct: 18,
    needsConfirmation:
      'Staff augmentation sits here or under 998314, and the distinction is who directs the work. ' +
      'If the client manages the person day to day it is staffing (998513); if Adpedia owns the ' +
      'deliverable and merely uses its own people, it is IT development (998314). 998519 is the ' +
      'residual "n.e.c." bucket and is harder to defend than either. Ask the CA once, per contract.',
  },
  {
    code: '998519',
    title: 'Other employment and labour supply services n.e.c.',
    use: 'Residual manpower-supply bucket where nothing more specific fits.',
    gstRatePct: 18,
    needsConfirmation:
      'This is a residual code. 998513 (contract staffing) is more specific and easier to defend — ' +
      'prefer it unless the CA says otherwise.',
  },
]

const BY_CODE = new Map(SAC_CODES.map((s) => [s.code, s]))

export function lookupSac(code: string | null | undefined): SacCode | null {
  return code ? BY_CODE.get(code.trim()) ?? null : null
}

/** Services sit in chapter 99; six digits is what the IRP and GSTR-1 expect. */
export const SAC_RE = /^99\d{4}$/

export type SacIssue = { level: 'error' | 'warn'; message: string }

/**
 * Check a SAC before it reaches an invoice.
 *
 * An unrecognised-but-well-formed code is a **warning**, not an error: the catalogue above
 * covers what Adpedia sells today, and refusing a legitimate code that is simply not listed
 * would be the system overruling the person who actually knows what they billed.
 */
export function validateSac(code: string | null | undefined): SacIssue[] {
  if (!code) return [{ level: 'error', message: 'Every invoice line needs a SAC code — it feeds the HSN/SAC summary in GSTR-1' }]
  const c = code.trim()

  if (!/^\d+$/.test(c)) return [{ level: 'error', message: `"${c}" is not numeric — a SAC is six digits` }]
  if (c.length !== 6) return [{ level: 'error', message: `"${c}" is ${c.length} digits; a SAC is six` }]
  if (!SAC_RE.test(c)) {
    return [{ level: 'error', message: `"${c}" is not a service code — services are chapter 99, so a SAC starts "99"` }]
  }

  const known = BY_CODE.get(c)
  if (!known) {
    return [{ level: 'warn', message: `${c} is a valid SAC format but is not one of the codes Adpedia normally uses — check it is right` }]
  }
  if (known.needsConfirmation) {
    return [{ level: 'warn', message: known.needsConfirmation }]
  }
  return []
}

/**
 * 🔴 Catch the specific mistake this module exists for: film and video work billed under an
 * IT or design code.
 *
 * It is easy to do — an invoice line is copied from the last one and the description changes
 * while the code does not — and it misstates the supply in GSTR-1, where the department
 * reads it.
 */
// the trailing s? matters: \b(film)\b does not match "films", and \b(motion graphic)\b
// does not match "motion graphics" — which is how the line is actually worded
const FILM_WORDS = /\b(film|video|shoot|footage|edit|vfx|motion graphic|animation|post[- ]production|colou?r grade|voice[- ]?over|dubbing|tvc|commercial|documentary|reel|trailer)s?\b/i
const NON_FILM_CODES = new Set(['998314', '998313', '998391', '998513', '998519'])

export function sacLooksWrongForDescription(description: string, code: string | null | undefined): SacIssue | null {
  if (!code || !FILM_WORDS.test(description)) return null
  if (!NON_FILM_CODES.has(code.trim())) return null
  return {
    level: 'warn',
    message: `"${description.slice(0, 60)}" reads like film or video work, but ${code} is an IT, design or staffing code. ` +
      'Production is 999612 and post-production is 999613.',
  }
}
