import { toJSONSchema, z } from 'zod'

const ID_PATTERN = /^[a-z][a-z0-9-]*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*\.[a-z][a-zA-Z0-9_-]*$/

/** Published plugin contract for `ModuleManifest` — validated at `ModuleRegistry.register()`. */
export const manifestSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  name: z.string().min(1),
  version: z.string().regex(VERSION_PATTERN),
  description: z.string().min(1).optional(),
  /** Empty is valid: a module may contribute no kernel tools (routes/settings only). */
  tools: z.array(z.string().regex(TOOL_NAME_PATTERN)),
  permissions: z.object({ roles: z.array(z.string()).min(1) }),
  /** Live ZodType — not JSON-Schema-able; accepted and ignored here. */
  settingsSchema: z.unknown().optional(),
  /** Declarative agent types (phase-1b, additive): accepted, not enforced. */
  agents: z
    .array(
      z.object({
        loopEngine: z.string().min(1),
        defaults: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  /** Declarative verification policies (phase-1b, additive): accepted, not enforced. */
  verification: z
    .array(z.object({ id: z.string().min(1), description: z.string().min(1) }))
    .optional(),
})

/** JSON Schema (draft 2020-12 via zod v4) for the module manifest — the published contract document. */
export function manifestJsonSchema(): Record<string, unknown> {
  return toJSONSchema(manifestSchema, { io: 'input' }) as Record<string, unknown>
}
