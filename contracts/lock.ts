import type { CoreEventDefinition } from '$lib/kernel/event-catalog'
import { toolInputJsonSchema, toolOutputJsonSchema } from '$lib/kernel/openapi'
import type { ApprovalRisk, AuditClass, ToolDescriptor } from '$lib/kernel/types'
import type { UiSlotDefinition } from '$lib/kernel/ui-slots'

/**
 * The shape of `contracts/core-api.lock.json` (plan/phase-upgrades.md R2, §5):
 * the core's public contract — every registry tool, every event, every UI
 * slot — snapshotted deterministically, with the contract's own semver.
 */

export type JsonSchema = Record<string, unknown>

export type LockedTool = {
  name: string
  module: string
  auditClass: AuditClass
  permission: { roles: string[] }
  approval: {
    /** Declared approval risk, or null when the tool declares none. */
    risk: ApprovalRisk | null
    /** The always-on approval wall (every call waits for a person). */
    always: boolean
    /** On the kernel's approval-gated list (waits per the owner's approval mode). */
    gated: boolean
  }
  /** The advertised input JSON Schema (the same one OpenAPI, MCP and the CLI derive from). */
  input: JsonSchema
  /** The output JSON Schema, or null when the tool declares no output schema. */
  output: JsonSchema | null
}

export type LockedEvent = {
  type: string
  module: string
  /** Payload JSON Schema; null records explicitly that the event declares none (yet). */
  payload: JsonSchema | null
}

export type LockedUiSlot = { name: string }

export type CoreApiLock = {
  coreApi: string
  tools: LockedTool[]
  events: LockedEvent[]
  uiSlots: LockedUiSlot[]
}

export type SnapshotInput = {
  coreApi: string
  tools: readonly ToolDescriptor[]
  /** The kernel's approval-gated tool names (APPROVAL_REQUIRED_TOOLS). */
  gated: ReadonlySet<string>
  events: Readonly<Record<string, CoreEventDefinition>>
  uiSlots: readonly UiSlotDefinition[]
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A schema without the `$schema` dialect marker (the same on every schema; noise in a diff). */
function lockSchema(schema: JsonSchema): JsonSchema {
  const rest = { ...schema }
  delete rest.$schema
  return rest
}

/** The contract of a set of registered tools, events and slots — pure, deterministic order. */
export function snapshotContract(input: SnapshotInput): CoreApiLock {
  const tools = [...input.tools]
    .sort((a, b) => byString(a.name, b.name))
    .map((tool): LockedTool => ({
      name: tool.name,
      module: tool.module,
      auditClass: tool.auditClass,
      permission: { roles: [...tool.permission.roles].sort(byString) },
      approval: {
        risk: tool.approvalRisk ?? null,
        always: tool.approvalAlways === true,
        gated: input.gated.has(tool.name),
      },
      input: lockSchema(toolInputJsonSchema(tool.inputSchema)),
      output:
        tool.outputSchema === undefined
          ? null
          : lockSchema(toolOutputJsonSchema(tool.outputSchema)),
    }))
  const events = Object.entries(input.events)
    .sort(([a], [b]) => byString(a, b))
    .map(([type, definition]): LockedEvent => ({
      type,
      module: definition.module,
      payload: definition.payload,
    }))
  const uiSlots = [...input.uiSlots]
    .sort((a, b) => byString(a.name, b.name))
    .map((slot): LockedUiSlot => ({ name: slot.name }))
  return { coreApi: input.coreApi, tools, events, uiSlots }
}

/**
 * Canonical JSON: object keys sorted, `required` lists sorted (a set in JSON
 * Schema), two-space indent, trailing newline. Array order is otherwise kept
 * (tools/events/slots are already sorted by name; enum order is the source's).
 */
export function serializeLock(lock: CoreApiLock): string {
  return `${JSON.stringify(canonical(lock), null, 2)}\n`
}

function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item))
    return key === 'required' && items.every((item) => typeof item === 'string')
      ? [...(items as string[])].sort(byString)
      : items
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(byString)
        .map((k) => [k, canonical((value as Record<string, unknown>)[k], k)]),
    )
  }
  return value
}

/** Parse a lock file, failing loud on a shape that is not a lock. */
export function parseLock(text: string, source: string): CoreApiLock {
  const value = JSON.parse(text) as Partial<CoreApiLock>
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.coreApi !== 'string' ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.uiSlots)
  ) {
    throw new Error(`${source} is not a core-api lock (needs coreApi, tools, events, uiSlots)`)
  }
  return value as CoreApiLock
}
