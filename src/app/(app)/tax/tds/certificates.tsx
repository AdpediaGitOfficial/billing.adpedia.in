'use client'
import { Fragment, useActionState, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardHeader, Pill, Button, Field, Alert, inputClass, inputStyle, tapTarget } from '@/components/ui/kit'
import { recordDownloadAction, recordIssuedAction } from './actions'

export interface CertificateView {
  id: string | null
  formType: '16' | '16A'
  quarter: number | null
  deducteeId: string
  deducteeName: string
  isEmployee: boolean
  pan: string | null
  tdsAmount: string
  dueOn: string
  downloadedOn: string | null
  issuedOn: string | null
  issuedTo: string | null
  attachments: number
  blockedBy: string | null
}

const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * The certificate chase — docs/55.
 *
 * 🔴 Nothing here generates a certificate. Rule 31(1) requires Form 16 and 16A to be
 * downloaded from TRACES; one produced here would carry no signature the deductee can verify,
 * and would evidence a credit the department never saw. What this does is say who is owed one,
 * by when, and what is standing in the way.
 */
export function Certificates({ rows }: { rows: CertificateView[] }) {
  const router = useRouter()
  const [download, downloadAction, downloading] = useActionState(recordDownloadAction, null)
  const [issue, issueAction, issuing] = useActionState(recordIssuedAction, null)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadFor, setUploadFor] = useState<string | null>(null)

  const outstanding = rows.filter((r) => !r.issuedOn).length

  async function upload(file: File, certificateId: string) {
    setBusy(true); setUploadError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('kind', 'TDS_CERTIFICATE')
      form.append('entityType', 'TdsCertificate')
      form.append('entityId', certificateId)
      const res = await fetch('/api/attachments', { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? 'Could not store that file')
      router.refresh()
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Could not store that file')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Card flush className="overflow-hidden">
      <CardHeader
        title="Certificates" className="p-5 pb-3"
        sub="Form 16A quarterly, Form 16 annually — downloaded from TRACES, never produced here"
        action={outstanding === 0
          ? <Pill tone="good" dot>all issued</Pill>
          : <Pill tone="warn" dot>{outstanding} outstanding</Pill>} />

      <div className="px-5 pb-3">
        <Alert tone="info" title="Only TRACES may generate these">
          Rule 31(1) requires Form 16 and Form 16A to be downloaded from the TRACES portal. One produced
          anywhere else carries no signature the deductee can verify, and evidences a credit the department
          never saw — so this screen records the real one rather than printing an imitation.
        </Alert>
      </div>

      <table className="w-full text-[12.5px]">
        <tbody>
          {rows.map((r) => {
            const key = `${r.formType}:${r.quarter ?? 'Y'}:${r.deducteeId}`
            return (
              <Fragment key={key}>
                <tr className="border-t align-top" style={{ borderColor: 'var(--rule)' }}>
                  <td className="px-5 py-2.5">
                    <span className="font-medium">{r.deducteeName}</span>
                    <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      Form {r.formType}{r.quarter ? ` · Q${r.quarter}` : ' · annual'}
                      {r.pan ? ` · ${r.pan}` : ' · no PAN'}
                    </span>
                  </td>
                  <td className="py-2.5 tabular" style={{ color: 'var(--text-muted)' }}>due {r.dueOn}</td>
                  <td className="py-2.5 text-right font-semibold tabular">{inr(r.tdsAmount)}</td>
                  <td className="py-2.5 text-center">
                    {r.issuedOn
                      ? <Pill tone="good" dot>issued</Pill>
                      : r.downloadedOn
                        ? <Pill tone="accent">downloaded</Pill>
                        : <Pill tone="neutral">not yet</Pill>}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <button type="button" onClick={() => setOpenRow(openRow === key ? null : key)}
                      className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>
                      {openRow === key ? 'close' : r.issuedOn ? 'details' : 'record'}
                    </button>
                  </td>
                </tr>

                {r.blockedBy && !r.issuedOn && (
                  <tr>
                    <td colSpan={5} className="px-5 pb-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      ↳ {r.blockedBy}
                    </td>
                  </tr>
                )}

                {openRow === key && (
                  <tr>
                    <td colSpan={5} className="px-5 pb-3">
                      <div className="space-y-3 rounded-lg p-3" style={{ background: 'var(--surface)' }}>
                        {!r.downloadedOn ? (
                          <form action={downloadAction} className="flex flex-wrap items-end gap-3">
                            <input type="hidden" name="formType" value={r.formType} />
                            <input type="hidden" name="quarter" value={r.quarter ?? ''} />
                            <input type="hidden" name="deducteeId" value={r.deducteeId} />
                            <input type="hidden" name="isEmployee" value={String(r.isEmployee)} />
                            <Field label="Downloaded on">
                              <input type="date" name="downloadedOn" required className={inputClass} style={inputStyle} />
                            </Field>
                            <Field label="TRACES request no." hint="optional">
                              <input name="tracesRequestNo" className={inputClass} style={inputStyle} />
                            </Field>
                            <Button size="sm" disabled={downloading}>
                              {downloading ? 'Saving…' : 'Record download'}
                            </Button>
                          </form>
                        ) : (
                          <>
                            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              Downloaded {r.downloadedOn}
                              {r.attachments > 0
                                ? ` · ${r.attachments} file${r.attachments === 1 ? '' : 's'} on record`
                                : ' · no file on record yet'}
                              {r.issuedOn && ` · issued ${r.issuedOn} to ${r.issuedTo}`}
                            </p>

                            {!r.issuedOn && (
                              <>
                                <button type="button" disabled={busy}
                                  onClick={() => { setUploadFor(r.id); fileRef.current?.click() }}
                                  className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--accent)' }}>
                                  {busy && uploadFor === r.id ? 'Uploading…' : 'Attach the downloaded PDF'}
                                </button>

                                <form action={issueAction} className="flex flex-wrap items-end gap-3">
                                  <input type="hidden" name="id" value={r.id ?? ''} />
                                  <Field label="Issued on">
                                    <input type="date" name="issuedOn" required className={inputClass} style={inputStyle} />
                                  </Field>
                                  <Field label="Sent to" hint="an email, a number, a person">
                                    <input name="issuedTo" required minLength={3} className={inputClass} style={inputStyle} />
                                  </Field>
                                  <Button size="sm" variant="ghost" disabled={issuing}>
                                    {issuing ? 'Saving…' : 'Record as issued'}
                                  </Button>
                                </form>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      <input ref={fileRef} type="file" className="hidden" accept="application/pdf,image/jpeg,image/png"
        onChange={(e) => { const f = e.target.files?.[0]; if (f && uploadFor) void upload(f, uploadFor) }} />

      <div className="px-5 pb-4">
        {[download?.error, download?.ok, issue?.error, issue?.ok, uploadError].filter(Boolean).map((m, i) => (
          <p key={i} className="mt-2 rounded-lg px-3 py-2 text-[12.5px]"
            style={{
              background: 'var(--surface)',
              color: m === download?.ok || m === issue?.ok ? 'var(--good)' : 'var(--critical)',
            }}>
            {m}
          </p>
        ))}
        {rows.length === 0 && (
          <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Nothing has been deducted this year, so nobody is owed a certificate.
          </p>
        )}
      </div>
    </Card>
  )
}
