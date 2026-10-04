import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { CAPABILITIES, can, type Capability } from '@/server/auth/permissions'
import { Card, PageHeader, Pill, Alert, FigureCard, FigureList } from '@/components/ui/kit'
import { listInvitations } from '@/server/services/auth/invitation'
import { ReverseButton } from '@/components/corrections/reverse-button'
import { InviteForm } from './invite-form'
import { revokeInvitationAction } from './actions'
import type { Role } from '@prisma/client'

const ROLES: Role[] = ['OWNER', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR']

/** Short enough for a phone card's label column. */
const ROLE_SHORT: Record<Role, string> = {
  OWNER: 'Owner', ACCOUNTANT: 'Acct', PROJECT_MANAGER: 'PM', EMPLOYEE: 'Staff', AUDITOR: 'Auditor',
}

function level(role: Role, capability: Capability) {
  return can(role, capability, 'write') ? 'edit' : can(role, capability, 'read') ? 'view' : '—'
}

const ROLE_NOTE: Record<Role, string> = {
  OWNER: 'Everything, including approving bills and paying salaries.',
  ACCOUNTANT: 'Day-to-day books, tax and banking. Cannot change company identity or users.',
  PROJECT_MANAGER: 'Their projects, and the bills against them. No payroll, no tax.',
  EMPLOYEE: 'Their own expenses and payslips. Nothing else.',
  AUDITOR: 'Read-only across the books. Cannot post, edit or approve anything.',
}

export default async function UsersPage() {
  const ctx = await requireContext()
  const members = await prisma.userCompany.findMany({
    where: { companyId: ctx.companyId },
    include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true, createdAt: true, isActive: true } } },
    orderBy: { role: 'asc' },
  })
  const live = members.filter((m) => m.user.isActive)
  const mayInvite = can(ctx.role, 'settings.users', 'write')
  const invitations = await listInvitations(ctx)
  const now = new Date()
  const openInvites = invitations.filter((i) => !i.acceptedAt && !i.revokedAt && i.expiresAt > now)

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Users &amp; roles"
        sub="Who can see and do what. The server enforces this independently of what the menu shows." />

      <Alert tone="info" title="Roles are enforced by the server, not by this page">
        Every request is checked against the matrix below, whoever is asking and whatever the menu
        shows &mdash; hiding a menu item has never been the control. Removing somebody is still done by
        deactivating their account; what this page can do is bring somebody in.
      </Alert>

      <Card flush className="overflow-hidden">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">
            {live.length} {live.length === 1 ? 'person' : 'people'}
            {members.length > live.length && ` · ${members.length - live.length} deactivated`}
          </span>
        </div>
        {/**
          * 🔴 docs/68 §7 — a deactivated account used to read exactly like a live one.
          *
          * This page lists `UserCompany` rows, and deactivating a user sets `isActive` on the
          * USER: the membership survives, so ten accounts that cannot sign in were being
          * presented, by the one screen whose whole subject is who can do what, as ten
          * owners. Found because the dev database had collected a preview account per
          * session and the phone layout put them one under another where it showed.
          */}
        <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
          {members.map((m) => (
            <div key={m.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-4 py-3">
              <div className="min-w-0">
                <span className="text-[13px] font-medium" style={m.user.isActive ? undefined : { color: 'var(--text-muted)' }}>
                  {m.user.name}
                </span>
                <span className="block truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{m.user.email}</span>
                <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  {m.user.lastLoginAt
                    ? `last signed in ${m.user.lastLoginAt.toISOString().slice(0, 10)}`
                    : 'never signed in'}
                </span>
              </div>
              {/* on a phone the pills always take their own line, rather than sometimes
                  wrapping and sometimes not depending on the length of a name */}
              <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
                {!m.user.isActive && <Pill tone="critical">deactivated</Pill>}
                <Pill tone={!m.user.isActive ? 'neutral' : m.role === 'OWNER' ? 'accent' : m.role === 'AUDITOR' ? 'neutral' : 'good'}>
                  {m.role.replace('_', ' ').toLowerCase()}
                </Pill>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {mayInvite && (
        <Card>
          <p className="eyebrow mb-1">Invite somebody</p>
          <p className="mb-4 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            An invitation is a credential, so it is treated like one: the link is high-entropy, only its
            hash is kept, it lasts a week and it can be used once. Accepting it sets a password and nothing
            else &mdash; it does not sign anybody in, because a link in an inbox that logs you in is a password
            in an inbox.
          </p>
          <InviteForm />
        </Card>
      )}

      {invitations.length > 0 && (
        <Card flush className="overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5"
               style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
            <span className="eyebrow">Invitations</span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {openInvites.length} open of {invitations.length}
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
            {invitations.map((i) => {
              const state = i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : i.expiresAt <= now ? 'expired' : 'open'
              return (
                <div key={i.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-4 py-3">
                  <div className="min-w-0">
                    <span className="text-[13px] font-medium" style={state === 'open' ? undefined : { color: 'var(--text-muted)' }}>
                      {i.name}
                    </span>
                    <span className="block truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{i.email}</span>
                    <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      {state === 'accepted' ? `accepted ${i.acceptedAt!.toISOString().slice(0, 10)}`
                        : state === 'revoked' ? `revoked — ${i.revokeReason}`
                        : state === 'expired' ? `expired ${i.expiresAt.toISOString().slice(0, 10)}`
                        : `good until ${i.expiresAt.toISOString().slice(0, 10)}`}
                    </span>
                  </div>
                  <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
                    <Pill tone={state === 'open' ? 'accent' : state === 'accepted' ? 'good' : 'neutral'}>
                      {i.role.replace('_', ' ').toLowerCase()}
                    </Pill>
                    {/* 🔴 The link is not here, and cannot be. Only its hash was kept. */}
                    {state === 'open' && mayInvite && (
                      <ReverseButton action={revokeInvitationAction} idName="invitationId" id={i.id}
                        label="revoke" confirmLabel="Revoke it" busyLabel="Revoking…"
                        prompt={`Why is the invitation to ${i.email} being withdrawn?`} />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Card flush className="overflow-hidden">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">What each role can do</span>
        </div>
        {/* 🔴 docs/68 §7 — a cross-tab is not a list, so it cannot become `DataTable` cards.
            On a phone it pivots: one card per capability, with the five roles down it. The
            desk keeps the grid, where comparing roles across a row is the whole point. */}
        <FigureList noun="capabilities">
          {CAPABILITIES.map((capability: Capability) => (
            <FigureCard key={capability} title={capability}
              figures={ROLES.map((r) => ({
                label: ROLE_SHORT[r],
                value: level(r, capability),
                strong: level(r, capability) === 'edit',
                muted: level(r, capability) === '—',
              }))} />
          ))}
        </FigureList>
        <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead>
            <tr style={{ background: 'var(--surface)' }}>
              <th className="px-4 py-2 text-left eyebrow">Area</th>
              {ROLES.map((r) => (
                <th key={r} className="px-2 py-2 text-center eyebrow">{r.replace('_', ' ').slice(0, 10)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAPABILITIES.map((capability: Capability) => (
              <tr key={capability} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-2">{capability}</td>
                {ROLES.map((r) => {
                  const read = can(r, capability, 'read')
                  const write = can(r, capability, 'write')
                  return (
                    <td key={r} className="px-2 py-2 text-center"
                      style={{ color: write ? 'var(--good)' : read ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                      {write ? 'edit' : read ? 'view' : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>

      <Card className="p-4">
        <p className="eyebrow mb-2">In words</p>
        <dl className="space-y-2 text-[12.5px]">
          {ROLES.map((r) => (
            <div key={r}>
              <dt className="font-semibold">{r.replace('_', ' ').toLowerCase()}</dt>
              <dd style={{ color: 'var(--text-muted)' }}>{ROLE_NOTE[r]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}
