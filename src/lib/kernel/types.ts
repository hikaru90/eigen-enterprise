import type { ZodType } from 'zod'

export type PrincipalKind = 'human' | 'agent' | 'service'

export type AuditClass = 'read' | 'mutate' | 'external'

/**
 * Declared approval risk of a tool (owner-chosen approval mode, "reasonable"):
 * internal = stays inside the company; public = visible to the world;
 * external = reaches a third party; destructive = removes capability or lands
 * irreversible changes. Declared per descriptor — never inferred from names.
 */
export type ApprovalRisk = 'internal' | 'public' | 'external' | 'destructive'

export type ToolContext = {
  principal: {
    id: string
    kind: PrincipalKind
    roles: string[]
  }
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
