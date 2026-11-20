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

/** Fails loud on a malformed principal: `via` only as the brain, on a person, with its agent id. */
export function assertWellFormedPrincipal(principal: ToolPrincipal): void {
  if (principal.via === undefined && principal.agentId === undefined) return
  if (principal.via !== BRAIN_VIA || principal.kind !== 'human' || !principal.agentId) {
    throw new KernelError(
      'invalid_principal',
      `principal ${principal.id} is malformed: only a person (kind human) can be acted for, via the brain, with the brain's agent id`,
    )
  }
}

/** One readable reference for audit lines and commit messages: `human:ann`, `human:ann via brain:orchestrator`. */
export function principalRef(principal: ToolPrincipal): string {
  const own = `${principal.kind}:${principal.id}`
  return isViaBrain(principal) ? `${own} via ${BRAIN_VIA}:${principal.agentId}` : own
}

/** Commit attribution: the actor's id, plus `via brain:<agent>` when the brain carried the call (`ann via brain:orchestrator`). */
export function attributionOf(principal: ToolPrincipal): string {
  return isViaBrain(principal) ? `${principal.id} via ${BRAIN_VIA}:${principal.agentId}` : principal.id
}

/** Provenance fields for event payloads: `{ via: 'brain', agentId }` for a delegated call, nothing otherwise. */
export function provenanceOf(principal: ToolPrincipal): { via: typeof BRAIN_VIA; agentId: string } | Record<string, never> {
  return isViaBrain(principal) ? { via: BRAIN_VIA, agentId: principal.agentId } : {}
}
