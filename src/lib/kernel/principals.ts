import type { PrincipalKind, ToolPrincipal } from './types'
import { KernelError } from './errors'

export const SYSTEM_PRINCIPAL_ID = 'system'

export type Principal = {
  id: string
  kind: PrincipalKind
  displayName?: string
  roles: string[]
  /** SHA-256 hex hash of the raw API key (see src/lib/server/api-keys/api-key-utils.ts). */
  apiKeyHash?: string | null
}

export type PrincipalStore = {
  getById(id: string): Promise<Principal | null>
  getByApiKey(apiKeyHash: string): Promise<Principal | null>
}

export class PrincipalService {
  constructor(private readonly store: PrincipalStore) {}

  /** `hashedKey` must already be hashed (sha256 hex) by the caller. */
  resolveByApiKey(hashedKey: string): Promise<Principal | null> {
    if (!hashedKey) throw new TypeError('resolveByApiKey requires a hashed key')
    return this.store.getByApiKey(hashedKey)
  }

  resolveById(id: string): Promise<Principal | null> {
    if (!id) throw new TypeError('resolveById requires an id')
    return this.store.getById(id)
  }
}

/**
 * The company brain acts as a person (plan/phase-company-brain.md §7, CB3).
 *
 * A person is a company member: their member id and their kernel roles —
 * exactly the rights they have themselves, never more. When the brain works
 * for them, every tool call runs under a DELEGATED principal: the person's id
 * and roles (kind 'human': the actor IS the person, so permission checks, row
 * level security, approvals and audit all see them), marked `via: 'brain'`
 * with the brain's agent id for provenance (actor = person, via = brain).
 * There is no other identity the brain can act as: no person, no run.
 */
export type PersonRef = {
  /** The member's user id. */
  id: string
  /** The member's kernel roles (src/lib/server/auth/roles.ts kernelRolesFor), never more. */
  roles: string[]
}

/** Looks up a member as a person the brain may act for; null when there is no such member. */
export type PersonDirectory = {
  personById(id: string): Promise<PersonRef | null>
}

export const BRAIN_VIA = 'brain' as const

export type DelegatedPrincipal = {
  id: string
  kind: 'human'
  roles: string[]
  via: typeof BRAIN_VIA
  /** The agent the person acts through (the brain's agent id). */
  agentId: string
}

/** The person's own principal while the brain acts for them. Fails loud on a missing person or agent. */
export function delegatedPrincipal(person: PersonRef, agentId: string): DelegatedPrincipal {
  requirePerson(person)
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new KernelError('invalid_principal', 'a delegated principal names the agent it acts through')
  }
  return { id: person.id, kind: 'human', roles: [...person.roles], via: BRAIN_VIA, agentId }
}

/** A dispatch, a background run or a tool call of the brain must name its person. */
export function requirePerson(person: PersonRef | null | undefined): asserts person is PersonRef {
  if (!person || typeof person.id !== 'string' || person.id.trim() === '' || !Array.isArray(person.roles)) {
    throw new KernelError(
      'no_person',
      'the company brain acts only as a person: this run names no person, so it does not run',
    )
  }
}

/** True when the brain is acting as this person (a delegated principal). */
export function isViaBrain(principal: ToolPrincipal): principal is DelegatedPrincipal {
  return principal.via === BRAIN_VIA
}

/**
 * The person themselves, at their own keyboard (a session, a route, the CLI) —
 * not the brain acting for them. Guards for a "person's own click" (brand
 * decisions G8, server changes D11, the always-ask approval wall, switching a
 * plugin a person switched off back on) ask this, never `kind === 'human'`.
 */
export function isDirectHuman(principal: ToolPrincipal): boolean {
  return principal.kind === 'human' && principal.via === undefined
}

/**
 * An AI co-worker (plan/phase-ai-coworkers.md §3): its own user id (a `user`
 * row with kind 'coworker'), member rights only (a co-worker is never owner or
 * admin), and the agent id its turns run as. Row level security scopes it by
 * its own id exactly like a person (server/kernel/principal-scope.ts).
 */
export type CoworkerPrincipal = {
  id: string
  kind: 'coworker'
  roles: string[]
  agentId: string
}

/** The principal a co-worker's tool calls run under. Fails loud on a missing user or agent id. */
export function coworkerPrincipal(userId: string, agentId: string): CoworkerPrincipal {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new KernelError('invalid_principal', "a co-worker principal names the co-worker's user id")
  }
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new KernelError('invalid_principal', 'a co-worker principal names the agent it runs as')
  }
  return { id: userId, kind: 'coworker', roles: ['member'], agentId }
}

/**
 * True for whoever acts as a company member with a seat: a person (at their
 * keyboard or through the brain) or an AI co-worker. Modules opt co-workers in
 * through this helper deliberately; the existing `kind === 'human'` guards keep
 * refusing them by default. Agents and services are no member.
 */
export function actsAsMember(principal: ToolPrincipal): boolean {
  return principal.kind === 'human' || principal.kind === 'coworker'
}

/**
 * Fails loud on a malformed principal: `via` brain only on a person, with its
 * agent id; `via` module only on a person, a co-worker or an agent, with its
 * module id (never a service: a module never holds rights of its own); a
 * co-worker otherwise carries its own agent id and never `via`.
 */
export function assertWellFormedPrincipal(principal: ToolPrincipal): void {
  if (principal.via === MODULE_VIA) {
    if (
      principal.kind === 'service' ||
      typeof principal.moduleId !== 'string' ||
      principal.moduleId.trim() === '' ||
      (principal.kind === 'coworker' &&
        (typeof principal.agentId !== 'string' || principal.agentId.trim() === ''))
    ) {
      throw new KernelError(
        'invalid_principal',
        `principal ${principal.id} is malformed: a module acts only as a person, a co-worker or an agent, and names its module`,
      )
    }
    return
  }
  if (principal.moduleId !== undefined) {
    throw new KernelError(
      'invalid_principal',
      `principal ${principal.id} is malformed: a module id travels only with via module`,
    )
  }
  if (principal.kind === 'coworker') {
    if (principal.via !== undefined || typeof principal.agentId !== 'string' || principal.agentId.trim() === '') {
      throw new KernelError(
        'invalid_principal',
        `principal ${principal.id} is malformed: a co-worker carries its own agent id and is never acted for via the brain`,
      )
    }
    return
  }
  if (principal.via === undefined && principal.agentId === undefined) return
  if (principal.via !== BRAIN_VIA || principal.kind !== 'human' || !principal.agentId) {
    throw new KernelError(
      'invalid_principal',
      `principal ${principal.id} is malformed: only a person (kind human) can be acted for, via the brain, with the brain's agent id`,
    )
  }
}

// ─── Company modules (plan/phase-upgrades-u2.md §4.3, D5) ────────────────────

export const MODULE_VIA = 'module' as const

/** The principal a company module acts under: exactly the invoker's id, kind and roles, marked `via: 'module'`. */
export type ModuleActingPrincipal = ToolPrincipal & { via: typeof MODULE_VIA; moduleId: string }

/**
 * A module acts as whoever invoked it — never more (the brain's rule): the
 * invoker's id, kind and roles (and a co-worker's agent id), plus `via:
 * 'module'` and the module's local id. A service invoker is refused: a module
 * always acts as someone.
 */
export function modulePrincipal(invoker: ToolPrincipal, moduleId: string): ModuleActingPrincipal {
  if (typeof moduleId !== 'string' || moduleId.trim() === '') {
    throw new KernelError('invalid_principal', 'a module principal names its module')
  }
  if (invoker.kind === 'service') {
    throw new KernelError('module_no_person', `module ${moduleId} acts only as a person: a service invoked it`)
  }
  return {
    id: invoker.id,
    kind: invoker.kind,
    roles: [...invoker.roles],
    via: MODULE_VIA,
    moduleId,
    ...(invoker.kind === 'coworker' && invoker.agentId ? { agentId: invoker.agentId } : {}),
  }
}

/** A module acting in the background, as its box-side owner (permissions.background, §4.3). */
export function moduleOwnerPrincipal(owner: PersonRef, moduleId: string): ModuleActingPrincipal {
  requirePerson(owner)
  return modulePrincipal({ id: owner.id, kind: 'human', roles: owner.roles }, moduleId)
}

/** True when a company module is acting as this principal. */
export function isViaModule(principal: ToolPrincipal): principal is ModuleActingPrincipal {
  return principal.via === MODULE_VIA
}

/** One readable reference for audit lines and commit messages: `human:ann`, `human:ann via brain:orchestrator`, `human:ann via module:invoices`. */
export function principalRef(principal: ToolPrincipal): string {
  const own = `${principal.kind}:${principal.id}`
  if (isViaModule(principal)) return `${own} via ${MODULE_VIA}:${principal.moduleId}`
  return isViaBrain(principal) ? `${own} via ${BRAIN_VIA}:${principal.agentId}` : own
}

/** Commit attribution: the actor's id, plus `via brain:<agent>` / `via module:<id>` when something carried the call. */
export function attributionOf(principal: ToolPrincipal): string {
  if (isViaModule(principal)) return `${principal.id} via ${MODULE_VIA}:${principal.moduleId}`
  return isViaBrain(principal) ? `${principal.id} via ${BRAIN_VIA}:${principal.agentId}` : principal.id
}

/** Provenance fields for event payloads: `{ via: 'brain', agentId }` / `{ via: 'module', moduleId }` for a carried call, nothing otherwise. */
export function provenanceOf(
  principal: ToolPrincipal,
):
  | { via: typeof BRAIN_VIA; agentId: string }
  | { via: typeof MODULE_VIA; moduleId: string }
  | Record<string, never> {
  if (isViaModule(principal)) return { via: MODULE_VIA, moduleId: principal.moduleId }
  return isViaBrain(principal) ? { via: BRAIN_VIA, agentId: principal.agentId } : {}
}
