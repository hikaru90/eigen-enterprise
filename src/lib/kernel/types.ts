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
  /** Namespaced tool name: "module.toolname". */
  name: string
  /** Owning module id — must equal the prefix of `name` before the first ".". */
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
  handler: (ctx: ToolContext, input: unknown) => Promise<unknown>
}
