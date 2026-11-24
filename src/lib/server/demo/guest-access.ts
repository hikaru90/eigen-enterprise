import { createHash } from 'node:crypto'
import { KernelError } from '$lib/kernel/errors'
import type { CoreEventType } from '$lib/kernel/event-catalog'
import type { MemberRole } from '$lib/server/auth/roles'
import type { UserKind } from '$lib/server/db/auth.schema'

/**
 * Login-free demo guest access (plan/phase-demo-company.md):
 *
 * Off by default on every company. Takes effect ONLY when all three hold:
 *   1. The internal `demo` module is active (`kernel_module_activations`),
 *   2. The owner switched guest access on (`demo_guest_access.enabled = true`),
 *   3. `guest_user_id` resolves to an existing human account with role `member`
 *      (never `owner`, never `admin`, never an AI co-worker).
 *
 * Visitors land on a one-click welcome card on `/login` and receive a normal
 * Better Auth session as that shared demo teammate — no email, no code, no
 * extra user rows. AI spend is capped per visitor IP per UTC day (default 2).
 */

/** Default shared teammate on the Northwind Studio demo company (role: member). */
export const DEFAULT_DEMO_GUEST_EMAIL = 'sophie.wagner@northwind-studio.example'

export const DEFAULT_DEMO_AI_CALLS_PER_IP = 2
export const MAX_DEMO_AI_CALLS_PER_IP = 50
/** Hard upper bound on raw gateway calls within one already-claimed demo AI turn. */
export const MAX_RAW_GATEWAY_CALLS_PER_DEMO_TURN = 12

export type DemoGuestConfig = {
  enabled: boolean
  guestUserId: string | null
  aiCallsPerIp: number
}

export type DemoGuestUserRecord = {
  id: string
  email: string
  name: string
  role: MemberRole | null
  kind: UserKind
}

export type ActiveDemoGuest = {
  userId: string
  email: string
  name: string
  aiCallsPerIp: number
}

export type DemoGuestAccessView = {
  enabled: boolean
  guest_user_id: string | null
  guest_email: string | null
  guest_name: string | null
  ai_calls_per_ip: number
}

export type DemoGuestStore = {
  get(): Promise<DemoGuestConfig | null>
  set(config: DemoGuestConfig, actorId: string): Promise<void>
}

export type DemoGuestAudit = (event: {
  type: CoreEventType
  principalId: string
  payload: Record<string, unknown>
}) => Promise<void>

export type DemoGuestDeps = {
  store: DemoGuestStore
  demoModuleActive: () => Promise<boolean>
  findUserById: (id: string) => Promise<DemoGuestUserRecord | null>
  findUserByEmail: (email: string) => Promise<DemoGuestUserRecord | null>
  audit: DemoGuestAudit
}

export type DemoGuestActor = {
  id: string
  role: MemberRole | null
}

/** SHA-256 hex digest of a normalized client IP (never stores raw IPs). */
export function hashClientIp(ip: string): string {
  const normalized = ip.trim().toLowerCase()
  if (!normalized) throw new Error('client IP must be non-empty')
  return createHash('sha256').update(normalized).digest('hex')
}

/** UTC calendar day string `YYYY-MM-DD`. */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function assertValidAiCalls(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_DEMO_AI_CALLS_PER_IP) {
    throw new KernelError(
      'invalid_input',
      `ai_calls_per_ip must be an integer between 0 and ${MAX_DEMO_AI_CALLS_PER_IP}; got ${n}.`,
    )
  }
}

function isEligibleGuestMember(
  u: DemoGuestUserRecord | null,
): u is DemoGuestUserRecord & { kind: 'human'; role: 'member' } {
  return u !== null && u.kind === 'human' && u.role === 'member'
}

/**
 * The currently active login-free demo guest, or `null` when login-free demo
 * access is off, the `demo` module is inactive, or the configured account is
 * not an eligible human `member` (defense in depth: promoting the teammate to
 * admin immediately disables login-free access).
 */
export async function resolveActiveDemoGuest(
  deps: Pick<DemoGuestDeps, 'store' | 'demoModuleActive' | 'findUserById'>,
): Promise<ActiveDemoGuest | null> {
  if (!(await deps.demoModuleActive())) return null
  const cfg = await deps.store.get()
  if (!cfg || !cfg.enabled || !cfg.guestUserId) return null
  const user = await deps.findUserById(cfg.guestUserId)
  if (!isEligibleGuestMember(user)) return null
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    aiCallsPerIp: cfg.aiCallsPerIp,
  }
}

export async function readDemoGuestAccess(
  actor: DemoGuestActor,
  deps: Pick<DemoGuestDeps, 'store' | 'findUserById'>,
): Promise<DemoGuestAccessView> {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw new KernelError(
      'permission_denied',
      'Only the owner or an admin can read demo guest access settings.',
    )
  }
  const cfg = await deps.store.get()
  if (!cfg) {
    return {
      enabled: false,
      guest_user_id: null,
      guest_email: null,
      guest_name: null,
      ai_calls_per_ip: DEFAULT_DEMO_AI_CALLS_PER_IP,
    }
  }
  const user = cfg.guestUserId ? await deps.findUserById(cfg.guestUserId) : null
  return {
    enabled: cfg.enabled,
    guest_user_id: user?.id ?? cfg.guestUserId,
    guest_email: user?.email ?? null,
    guest_name: user?.name ?? null,
    ai_calls_per_ip: cfg.aiCallsPerIp,
  }
}

export async function configureDemoGuestAccess(
  actor: DemoGuestActor,
  input: { enabled: boolean; guest_email?: string; ai_calls_per_ip?: number },
  deps: DemoGuestDeps,
): Promise<DemoGuestAccessView> {
  if (actor.role !== 'owner') {
    throw new KernelError(
      'permission_denied',
      'Only the company owner can change login-free demo guest access.',
    )
  }

  const current = await deps.store.get()
  const aiCallsPerIp =
    input.ai_calls_per_ip ?? current?.aiCallsPerIp ?? DEFAULT_DEMO_AI_CALLS_PER_IP
  assertValidAiCalls(aiCallsPerIp)

  let targetUser: DemoGuestUserRecord | null = null
  if (input.guest_email !== undefined) {
    const email = input.guest_email.trim().toLowerCase()
    targetUser = await deps.findUserByEmail(email)
    if (!targetUser) {
      throw new KernelError(
        'invalid_input',
        `No member found with email "${email}". Seed the demo company first or pick an existing member.`,
      )
    }
    if (!isEligibleGuestMember(targetUser)) {
      throw new KernelError(
        'invalid_input',
        `Demo guest access may only use a human member account (never an owner, admin, or AI co-worker); "${email}" is ${targetUser.kind === 'coworker' ? 'an AI co-worker' : `role "${targetUser.role}"`}.`,
      )
    }
  } else if (current?.guestUserId) {
    targetUser = await deps.findUserById(current.guestUserId)
  }

  if (input.enabled) {
    if (!targetUser) {
      targetUser = await deps.findUserByEmail(DEFAULT_DEMO_GUEST_EMAIL)
      if (!targetUser) {
        throw new KernelError(
          'invalid_input',
          `Default demo teammate "${DEFAULT_DEMO_GUEST_EMAIL}" does not exist yet. Run demo.seed_company first or pass guest_email for an existing member.`,
        )
      }
    }
    if (!isEligibleGuestMember(targetUser)) {
      throw new KernelError(
        'invalid_input',
        `Demo guest access may only use a human member account (never an owner, admin, or AI co-worker); "${targetUser.email}" is ${targetUser.kind === 'coworker' ? 'an AI co-worker' : `role "${targetUser.role}"`}.`,
      )
    }
  }

  const next: DemoGuestConfig = {
    enabled: input.enabled,
    guestUserId: targetUser?.id ?? null,
    aiCallsPerIp,
  }
  await deps.store.set(next, actor.id)
  await deps.audit({
    type: 'demo.guest_access_changed',
    principalId: actor.id,
    payload: {
      enabled: next.enabled,
      was: current?.enabled ?? false,
      guestUserId: next.guestUserId,
      aiCallsPerIp: next.aiCallsPerIp,
    },
  })

  return {
    enabled: next.enabled,
    guest_user_id: targetUser?.id ?? null,
    guest_email: targetUser?.email ?? null,
    guest_name: targetUser?.name ?? null,
    ai_calls_per_ip: next.aiCallsPerIp,
  }
}

/** In-memory store for unit tests. */
export function memoryDemoGuestStore(
  initial: DemoGuestConfig | null = null,
): DemoGuestStore & { updatedBy: string | null } {
  let state: DemoGuestConfig | null = initial ? { ...initial } : null
  const store = {
    updatedBy: null as string | null,
    get: async () => (state ? { ...state } : null),
    set: async (next: DemoGuestConfig, actorId: string) => {
      state = { ...next }
      store.updatedBy = actorId
    },
  }
  return store
}
