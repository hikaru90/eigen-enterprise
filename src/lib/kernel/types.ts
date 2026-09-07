import type { ZodType } from 'zod'

export type PrincipalKind = 'human' | 'agent' | 'service'

export type AuditClass = 'read' | 'mutate' | 'external'

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
  permission: {
    /** Principal roles allowed to execute; execute() requires a non-empty intersection. */
    roles: string[]
  }
  auditClass: AuditClass
  handler: (ctx: ToolContext, input: unknown) => Promise<unknown>
}
