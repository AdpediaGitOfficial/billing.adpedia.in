import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { CAPABILITIES, can, type Capability } from '@/server/auth/permissions'
import { Card, PageHeader, Pill, Alert } from '@/components/ui/kit'
import type { Role } from '@prisma/client'

const ROLES: Role[] = ['OWNER', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR']

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
    include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true, createdAt: true } } },
    orderBy: { role: 'asc' },
  })

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Users &amp; roles"
        sub="Who can see and do what. The server enforces this independently of what the menu shows." />

      <Alert tone="info" title="Read-only for now">
        Inviting and removing users is not wired up yet. Roles are enforced on every request by
        the server, so this page describes the rules rather than being where they live &mdash;
        hiding a menu item has never been the control.
      </Alert>

      <Card flush className="overflow-hidden">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">{members.length} {members.length === 1 ? 'person' : 'people'}</span>
        </div>
        <table className="w-full text-[13px]">
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-3">
                  <span className="font-medium">{m.user.name}</span>
                  <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{m.user.email}</span>
                </td>
                <td className="px-4 py-3 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  {m.user.lastLoginAt
                    ? `last signed in ${m.user.lastLoginAt.toISOString().slice(0, 10)}`
                    : 'never signed in'}
                </td>
                <td className="px-4 py-3 text-right">
                  <Pill tone={m.role === 'OWNER' ? 'accent' : m.role === 'AUDITOR' ? 'neutral' : 'good'}>
                    {m.role.replace('_', ' ').toLowerCase()}
                  </Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card flush className="overflow-x-auto">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">What each role can do</span>
        </div>
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
