import type { ZodType } from 'zod'

/**
 * Who a principal is: a person (human), an AI co-worker (coworker: a `user` row
 * with kind 'coworker', its own seat in the org chart — plan/phase-ai-coworkers.md
 * §3), an agent (the brain's machinery) or a service. A co-worker is scoped by row
 * level security like a person, but it is never a person: every `kind === 'human'`
 * guard refuses it until its module opts in (actsAsMember, principals.ts).
 */
export type PrincipalKind = 'human' | 'coworker' | 'agent' | 'service'

export type AuditClass = 'read' | 'mutate' | 'external'

/**
 * Declared approval risk of a tool (owner-chosen approval mode, "reasonable"):
 * internal = stays inside the company; public = visible to the world;
 * external = reaches a third party; destructive = removes capability or lands
 * irreversible changes. Declared per descriptor — never inferred from names.
 */
export type ApprovalRisk = 'internal' | 'public' | 'external' | 'destructive'

/**
 * Who a tool call runs as. When the company brain acts for a person, this is
 * that person's DELEGATED principal (principals.ts delegatedPrincipal): their
 * id and roles, kind 'human', plus `via: 'brain'` and the brain's agent id —
 * the actor is the person, the brain is only how the call arrived. There is
 * no separate "acting user": the principal IS the person.
 */
export type ToolPrincipal = {
  id: string
  kind: PrincipalKind
  roles: string[]
  /**
   * Set only when something acts as this person (provenance; never a
   * permission): `brain` = the company brain; `module` = a company module
   * (plan/phase-upgrades-u2.md §4.3), with `moduleId`.
   */
  via?: 'brain' | 'module'
  /**
   * The brain's agent id when `via` is brain; a co-worker's own agent id (kind
   * 'coworker', never with `via` brain). Absent otherwise.
   */
  agentId?: string
  /** The company module (its local id, `hello`) when `via` is module. Absent otherwise. */
  moduleId?: string
}

export type ToolContext = {
  principal: ToolPrincipal
  requestId: string
}

export type ToolDescriptor = {
  /** Namespaced tool name: "namespace.toolname". */
  name: string
  /**
   * Owning module id. The prefix of `name` before the first "." must be one of
   * the owning manifest's toolNamespaces (default: exactly the module id).
   * Merged modules own several namespaces, so tool names never changed.
   */
  module: string
  summary: string
  inputSchema: ZodType
  /** When set, execute() validates the handler result; MCP + OpenAPI advertise the compiled JSON Schema. */
  outputSchema?: ZodType
  permission: {
    /** Principal roles allowed to execute; execute() requires a non-empty intersection. */
    roles: string[]
  }
  auditClass: AuditClass
  /** Required for every tool the approval policy gates (load-time error otherwise). */
  approvalRisk?: ApprovalRisk
  /**
   * The always-on approval wall: every call waits for a person's decision in
   * EVERY approval mode (allow_all included), the decision covers exactly one
   * call with exactly the approved input, and only a human principal can
   * decide it (kernel.approvals_decide refuses agents). Enforced by the
   * registry itself, not the pluggable policy. Non-read tools only; requires
   * approvalRisk (registration fails loud otherwise).
   */
  approvalAlways?: true
  /**
   * What this call did, in plain words for the owner: one short past-tense
   * sentence ("Published the About page"). Required for every non-read tool
   * (registration fails loud otherwise). The registry calls it after the
   * handler with the parsed input and the result; on a failed call `output`
   * is undefined and the sentence comes from the input alone. It is stored
   * in the audit trail, so it must never contain keys, tokens or passwords.
   * Method syntax on purpose: each tool declares its own input/output types.
   */
  activity?(input: unknown, output: unknown): string
  handler: (ctx: ToolContext, input: unknown) => Promise<unknown>
}
