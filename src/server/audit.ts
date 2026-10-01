import { prisma } from '@/server/db'
import type { Tx } from '@/server/db'
import type { RequestContext } from '@/server/context'

export type AuditAction = 'CREATE' | 'UPDATE' | 'CANCEL' | 'POST' | 'REVERSE' | 'LOGIN' | 'LOGOUT' | 'APPROVE'

/** Append-only. Never updated, never deleted. */
export async function audit(
  ctx: Pick<RequestContext, 'companyId' | 'userId'>,
  entry: { entity: string; entityId: string; action: AuditAction; before?: unknown; after?: unknown; ip?: string },
  tx: Tx = prisma,
) {
  await tx.auditLog.create({
    data: {
      companyId: ctx.companyId,
      userId: ctx.userId,
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      before: (entry.before ?? undefined) as never,
      after: (entry.after ?? undefined) as never,
      ip: entry.ip,
    },
  })
}
