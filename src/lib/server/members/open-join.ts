import type { CoreEventType } from '$lib/kernel/event-catalog'
import { MemberError, type Actor } from './service'

/**
 * Open join (plan/phase-demo-company.md D1, `members.open_join`): a company
 * setting, off by default. When on, `/signup` on a claimed ee server lets
 * anyone who verifies their email with the normal sign-in code join as a
 * `member` (the user-create hook re-reads it at the moment the account is
 * made, inside openJoinScope). Only the owner or an admin reads or switches
 * it — Settings → Members and the members.get_open_join / members.set_open_join
 * tools — and every switch is audited as a kernel event.
 */

export type OpenJoinStore = {
  /** Off when never set. */
  get(): Promise<boolean>
  set(on: boolean, actorId: string): Promise<void>
}

export type OpenJoinAudit = (event: { type: CoreEventType; principalId: string; payload: Record<string, unknown> }) => Promise<void>

export type OpenJoinDeps = { store: OpenJoinStore; audit: OpenJoinAudit }

export type OpenJoinView = { openJoin: boolean }

function assertCanManage(actor: Actor): void {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw new MemberError('forbidden', 'Only the owner or an admin can change who may join.')
  }
}

export async function readOpenJoin(actor: Actor, deps: Pick<OpenJoinDeps, 'store'>): Promise<OpenJoinView> {
  assertCanManage(actor)
  return { openJoin: await deps.store.get() }
}

export async function setOpenJoin(actor: Actor, input: { on: boolean }, deps: OpenJoinDeps): Promise<OpenJoinView> {
  assertCanManage(actor)
  const before = await deps.store.get()
  await deps.store.set(input.on, actor.id)
  await deps.audit({ type: 'members.open_join_changed', principalId: actor.id, payload: { openJoin: input.on, was: before } })
  return { openJoin: input.on }
}

/** The plain refusal on /signup when open join is off. */
export function openJoinOffMessage(companyName: string | null): string {
  return `${companyName ?? 'This company'} is not open to join. Ask the owner for an invite.`
}

/** In-memory store (tests). */
export function memoryOpenJoinStore(initial = false): OpenJoinStore & { updatedBy: string | null } {
  let on = initial
  const s = {
    updatedBy: null as string | null,
    get: async () => on,
    set: async (next: boolean, actorId: string) => {
      on = next
      s.updatedBy = actorId
    },
  }
  return s
}
