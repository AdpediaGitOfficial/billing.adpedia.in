import { createHash } from 'node:crypto'
import { AppError } from '@/server/errors'
import type { ValidationIssue } from './payload'

/**
 * The IRP adapter.
 *
 * Every GSP (ClearTax, Masters India, IRIS, the NIC portal direct) speaks a different
 * dialect of the same thing, and which one Adpedia uses is a commercial decision nobody
 * has made. So the rest of the system talks to THIS interface, and swapping providers is
 * writing one class — not touching invoicing.
 */

export interface IrpAck {
  irn: string
  ackNo: string
  ackDate: Date
  /** base64 JWS the IRP signs; it is what the printed QR encodes */
  signedQr: string
  signedInvoice?: string
  status: 'ACT' | 'CNL'
}

export interface IrpError {
  code: string
  message: string
}

export interface IrpAdapter {
  readonly name: string
  generate(payload: Record<string, unknown>): Promise<IrpAck>
  /** 🔴 the IRP allows cancellation within 24 hours of the ack, and not a minute after */
  cancel(irn: string, reason: '1' | '2' | '3' | '4', remark: string): Promise<{ irn: string; cancelDate: Date }>
}

export class EInvoiceError extends AppError {
  constructor(message: string, readonly issues: ValidationIssue[] = [], readonly irpErrors: IrpError[] = []) {
    super(message, 422, 'EINVOICE')
  }
}

/**
 * A deterministic stand-in for development and tests.
 *
 * 🔴 It does NOT talk to the IRP and the IRN it returns is NOT a government record. It
 * exists so the surrounding code — validation, persistence, the PDF, cancellation windows
 * — can be built and tested without credentials Adpedia does not need yet. The name is
 * deliberately conspicuous so a mock IRN is never mistaken for a real one.
 */
export class MockIrpAdapter implements IrpAdapter {
  readonly name = 'MOCK — not a real IRP'

  async generate(payload: Record<string, unknown>): Promise<IrpAck> {
    const doc = payload.DocDtls as { No: string; Dt: string } | undefined
    const seller = payload.SellerDtls as { Gstin: string } | undefined
    if (!doc || !seller) throw new EInvoiceError('Payload is missing DocDtls or SellerDtls')

    // the real IRN is a SHA-256 over supplier GSTIN + doc type + doc number + FY; mirroring
    // the shape keeps column widths and UI honest
    const irn = createHash('sha256')
      .update(`${seller.Gstin}-${(payload.DocDtls as { Typ: string }).Typ}-${doc.No}-${doc.Dt}`)
      .digest('hex')

    return {
      irn,
      ackNo: String(Date.now()).slice(-10),
      ackDate: new Date(),
      signedQr: Buffer.from(JSON.stringify({ mock: true, irn, doc: doc.No })).toString('base64'),
      status: 'ACT',
    }
  }

  async cancel(irn: string): Promise<{ irn: string; cancelDate: Date }> {
    return { irn, cancelDate: new Date() }
  }
}

/**
 * The live adapter is intentionally NOT implemented.
 *
 * Writing an untested HTTP client against a government API — with auth token caching,
 * public-key encryption of the payload and a provider-specific error table — and leaving
 * it looking finished would be worse than an honest gap. It would be found at the moment
 * it is first needed, on a real invoice, with a deadline.
 *
 * What is needed to complete it is written down in docs/31 §6.
 */
export class LiveIrpAdapter implements IrpAdapter {
  readonly name = 'LIVE (not implemented)'

  async generate(): Promise<IrpAck> {
    throw new EInvoiceError(
      'The live IRP client is not implemented. Adpedia is far below the ₹5 Cr threshold, so no GSP has been chosen and no credentials exist. See docs/31 §6 for what completing it requires.',
    )
  }

  async cancel(): Promise<{ irn: string; cancelDate: Date }> {
    throw new EInvoiceError('The live IRP client is not implemented.')
  }
}

export function irpAdapter(): IrpAdapter {
  return process.env.IRP_MODE === 'live' ? new LiveIrpAdapter() : new MockIrpAdapter()
}

/** The IRP's own window: 24 hours from the acknowledgement, no extension, no exception. */
export const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000

export function cancellableUntil(ackDate: Date): Date {
  return new Date(ackDate.getTime() + CANCEL_WINDOW_MS)
}

export function canCancel(ackDate: Date, now: Date = new Date()): boolean {
  return now.getTime() <= cancellableUntil(ackDate).getTime()
}
