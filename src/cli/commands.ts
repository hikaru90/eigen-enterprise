import type { ParsedCliArgs } from './args'
import { KernelError } from '$lib/kernel/errors'
import type { ActivationStore } from '$lib/kernel/modules'
import { generateOpenApi, strictToolSchema, toolInputJsonSchema } from '$lib/kernel/openapi'
import type { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { listMcpTools } from '$lib/server/mcp/server'
import { CliArgsError, usageText } from './args'

/**
 * Pure command handlers: parsed args -> kernel registry.execute calls. Every
 * command — including admin operations — goes through the registry so
 * permissions, approvals, and audit apply. No process IO here; index.ts owns
 * printing and exit codes.
 */

/** The registry surface the commands use (the brain's ee tool hands in a scope-guarded view). */
export type CliRegistry = Pick<KernelRegistry, 'execute' | 'list' | 'get' | 'getApprovalStore'>

/**
 * Who may see what in discovery (`tool list`, `tool namespaces`, `tool help`).
 * Absent (the terminal CLI): every registered tool, listings filtered by
 * module activation only — the MCP tools/list mirror. The company brain's ee
 * tool passes the person's reach (their roles ∩ the agent's tool scope) and
 * asks for compact listings (no schemas: `tool help` carries the schema).
 * Discovery only — execution is always the registry's own permission check.
 */
export type CliDiscovery = {
  mayRun: (tool: ToolDescriptor) => boolean
  /** Include each tool's input schema in `tool list` (terminal default: true). */
  listSchemas: boolean
}

export type CliCommandContext = {
  registry: CliRegistry
  activations: Pick<ActivationStore, 'get'>
  principal: ToolContext['principal']
  requestId: string
  discovery?: CliDiscovery
}

export type CommandError = { code: string; message: string; approvalId?: string }

export type CommandOutcome =
  | { exitCode: 0; data: unknown }
  | { exitCode: 1; error: CommandError }
  | { exitCode: 3; error: CommandError }

export class CliUsageError extends CliArgsError {}

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_APPROVAL_REQUIRED = 3

/**
 * Shape-only validation, runnable before any kernel wiring so malformed
 * commands fail fast without DATABASE_URL or principal requirements.
 */
export function validateParsedCommand(args: ParsedCliArgs): void {
  switch (args.group) {
    case 'status':
    case 'openapi':
      return requireNoAction(args)
    case 'tool':
      if (args.action === 'run') {
        requirePositional(args, 'tool name')
        requireStringFlag(args, 'input')
        requireValidJson(args)
        return
      }
      if (args.action === 'help') {
        requirePositional(args, 'tool name')
        return
      }
      if (args.action === 'list' || args.action === 'namespaces') return
      throw usageError(actionMessage(args))
    case 'module':
      if (args.action === 'activate' || args.action === 'deactivate') {
        requirePositional(args, 'module id')
        return
      }
      if (args.action === 'list') return
      throw usageError(actionMessage(args))
    case 'approvals':
      if (args.action === 'list') return
      if (args.action === 'decide') {
        requirePositional(args, 'approval id')
        const approve = args.flags.approve === true
        const deny = args.flags.deny === true
        if (approve === deny) {
          throw usageError('approvals decide requires exactly one of --approve or --deny')
        }
        return
      }
      throw usageError(actionMessage(args))
    default:
      throw usageError(`unknown command group: ${args.group}`)
  }
}

/** Map a validated command to its registry execution. Throws on failure; index.ts maps errors. */
export async function dispatchCommand(
  ctx: CliCommandContext,
  args: ParsedCliArgs,
): Promise<CommandOutcome> {
  try {
    const data = await runCommand(ctx, args)
    return { exitCode: EXIT_OK, data }
  } catch (err) {
    return await outcomeFromError(err, ctx, args)
  }
}

/**
 * Run a validated command and return its data; failures THROW (KernelError
 * from the registry, CliUsageError for a malformed command) — for in-process
 * callers that map errors themselves (the brain's ee tool: the engine turns a
 * thrown KernelError into the same structured tool error / approval card a
 * direct tool call gets). dispatchCommand is the exit-code-mapped variant.
 */
export async function executeCommand(ctx: CliCommandContext, args: ParsedCliArgs): Promise<unknown> {
  return runCommand(ctx, args)
}

async function runCommand(ctx: CliCommandContext, args: ParsedCliArgs): Promise<unknown> {
  const toolCtx = (): ToolContext => ({ principal: ctx.principal, requestId: ctx.requestId })
  const registry = ctx.registry

  switch (args.group) {
    case 'status': {
      const modules = await registry.execute('kernel.module_list', {}, toolCtx())
      const pendingApprovals = await registry.execute(
        'kernel.approvals_list',
        { status: 'pending' },
        toolCtx(),
      )
      return { modules, pendingApprovals }
    }
    case 'tool':
      if (args.action === 'list') return toolList(ctx, args)
      if (args.action === 'namespaces') return toolNamespaces(ctx)
      if (args.action === 'help') return toolHelp(ctx, requirePositional(args, 'tool name'))
      return registry.execute(
        requirePositional(args, 'tool name'),
        requireJsonInput(args),
        toolCtx(),
      )
    case 'module': {
      if (args.action === 'list') return registry.execute('kernel.module_list', {}, toolCtx())
      const toolName =
        args.action === 'activate' ? 'kernel.module_activate' : 'kernel.module_deactivate'
      const module_id = requirePositional(args, 'module id')
      return registry.execute(toolName, { module_id }, toolCtx())
    }
    case 'approvals': {
      if (args.action === 'list') {
        const status = args.flags.status
        const input = typeof status === 'string' ? { status } : {}
        return registry.execute('kernel.approvals_list', input, toolCtx())
      }
      const approval_id = requirePositional(args, 'approval id')
      const decision = args.flags.approve === true ? 'approved' : 'denied'
      return registry.execute('kernel.approvals_decide', { approval_id, decision }, toolCtx())
    }
    case 'openapi':
      return generateOpenApi(registry, { title: 'eigenEnterprise kernel', version: '0.1.0' })
    default:
      throw usageError(`unknown command group: ${args.group}`)
  }
}

/**
 * Tool listing: the SAME fail-closed activation filter as the MCP server's
 * tools/list (listMcpTools), optionally narrowed to one module. No duplicate
 * of the filter — this is the filter.
 */
async function toolList(ctx: CliCommandContext, args: ParsedCliArgs): Promise<unknown> {
  const module = typeof args.flags.module === 'string' ? args.flags.module : undefined
  const namespace = typeof args.flags.namespace === 'string' ? args.flags.namespace : undefined
  const listSchemas = ctx.discovery?.listSchemas ?? true
  return (await listedTools(ctx, module))
    .filter((tool) => namespace === undefined || namespaceOf(tool.name) === namespace)
    .map((tool) => ({
      name: tool.name,
      description: tool.summary,
      // Same strict-subset projection the MCP listing serves — this listing
      // mirrors what MCP clients see.
      ...(listSchemas ? { inputSchema: strictToolSchema(toolInputJsonSchema(tool.inputSchema)) } : {}),
    }))
}

/** Active-module tools (the MCP tools/list filter — no duplicate of it) within the caller's discovery reach. */
async function listedTools(ctx: CliCommandContext, module?: string): Promise<ToolDescriptor[]> {
  const listings = await listMcpTools(ctx.registry, ctx.activations)
  const listed = new Set(listings.map((l) => l.name))
  const mayRun = ctx.discovery?.mayRun ?? (() => true)
  return ctx.registry
    .list(module === undefined ? undefined : { module })
    .filter((tool) => listed.has(tool.name) && mayRun(tool))
}

/** The tool-name namespace: the prefix before the first "." (`reminders.list` → `reminders`). */
function namespaceOf(name: string): string {
  const dot = name.indexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/** `ee tool namespaces`: the namespaces `tool list` would show, with tool counts (the smallest map of the surface). */
async function toolNamespaces(ctx: CliCommandContext): Promise<Array<{ namespace: string; tools: number }>> {
  const counts = new Map<string, number>()
  for (const tool of await listedTools(ctx)) {
    const ns = namespaceOf(tool.name)
    counts.set(ns, (counts.get(ns) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, tools]) => ({ namespace, tools }))
}

/**
 * `ee tool help <name>`: one tool's description and input schema (the same
 * strict projection MCP serves), its audit class, whether it can ask for
 * approval, and whether its module is active. A tool outside the caller's
 * discovery reach is refused like a run would be; an unknown one is unknown.
 */
async function toolHelp(ctx: CliCommandContext, name: string): Promise<unknown> {
  const tool = ctx.registry.get(name)
  if (!tool) throw new KernelError('unknown_tool', `unknown tool: ${name} (ee tool list shows the tools there are)`)
  if (ctx.discovery && !ctx.discovery.mayRun(tool)) {
    throw new KernelError('permission_denied', `${name} is not within your reach: the person you act for may not run it`)
  }
  return {
    name: tool.name,
    description: tool.summary,
    module: tool.module,
    auditClass: tool.auditClass,
    ...(tool.approvalAlways === true ? { approval: 'always' } : tool.auditClass === 'read' ? {} : { approval: 'by approval mode' }),
    active: await ctx.activations.get(tool.module),
    inputSchema: strictToolSchema(toolInputJsonSchema(tool.inputSchema)),
  }
}

async function outcomeFromError(
  err: unknown,
  ctx: CliCommandContext,
  args: ParsedCliArgs,
): Promise<CommandOutcome> {
  if (err instanceof CliUsageError) {
    return { exitCode: EXIT_ERROR, error: { code: 'usage', message: err.message } }
  }
  if (err instanceof CliJsonInputError) {
    return { exitCode: EXIT_ERROR, error: { code: 'invalid_json', message: err.message } }
  }
  if (err instanceof KernelError) {
    if (err.code === 'approval_required') {
      return {
        exitCode: EXIT_APPROVAL_REQUIRED,
        error: {
          code: err.code,
          message: err.message,
          approvalId: await pendingApprovalId(ctx, args),
        },
      }
    }
    return { exitCode: EXIT_ERROR, error: { code: err.code, message: err.message } }
  }
  return {
    exitCode: EXIT_ERROR,
    error: { code: 'error', message: err instanceof Error ? err.message : String(err) },
  }
}

/**
 * Best-effort enrichment of approval_required: surface the pending request id
 * when the approval store has one for this tool+principal. The exit code and
 * message stand on their own when no id is available.
 */
async function pendingApprovalId(
  ctx: CliCommandContext,
  args: ParsedCliArgs,
): Promise<string | undefined> {
  const toolName = args.group === 'tool' && args.action === 'run' ? args.positionals[0] : undefined
  if (toolName === undefined) return undefined
  try {
    const latest = await ctx.registry.getApprovalStore().latestFor(toolName, ctx.principal.id)
    return latest?.status === 'pending' ? latest.id : undefined
  } catch (_err) {
    return undefined
  }
}

class CliJsonInputError extends Error {}

function requireJsonInput(args: ParsedCliArgs): unknown {
  const raw = args.flags.input
  if (typeof raw !== 'string') throw usageError("tool run requires --input '<json>'")
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new CliJsonInputError(`--input is not valid JSON: ${(err as Error).message}`)
  }
}

function requireNoAction(args: ParsedCliArgs): void {
  if (args.action !== undefined) throw usageError(actionMessage(args))
}

function requirePositional(args: ParsedCliArgs, label: string): string {
  const value = args.positionals[0]
  if (value === undefined) throw usageError(`missing ${label}`)
  return value
}

function requireStringFlag(args: ParsedCliArgs, name: string): void {
  if (typeof args.flags[name] !== 'string') throw usageError(`--${name} is required`)
}

function requireValidJson(args: ParsedCliArgs): void {
  const raw = args.flags.input
  if (typeof raw !== 'string') return
  try {
    JSON.parse(raw)
  } catch (err) {
    throw new CliJsonInputError(`--input is not valid JSON: ${(err as Error).message}`)
  }
}

function actionMessage(args: ParsedCliArgs): string {
  return args.action === undefined
    ? `missing action for "${args.group}"`
    : `unknown action for "${args.group}": ${args.action}`
}

function usageError(message: string): CliUsageError {
  return new CliUsageError(`${message}\n${usageText()}`)
}

/**
 * Render an outcome for the terminal: success data as JSON (--json) or as
 * compact human-readable lines; error outcomes always as structured JSON on
 * stderr ({ code, message, approvalId? }).
 */
/** Rendered strings carry no trailing newline; the entrypoint's console writers add one. */
export function renderOutcome(
  outcome: CommandOutcome,
  asJson: boolean,
): { stdout: string; stderr: string } {
  if (outcome.exitCode === EXIT_OK) {
    return {
      stdout: asJson ? JSON.stringify(outcome.data, null, 2) : renderHuman(outcome.data),
      stderr: '',
    }
  }
  const payload: Record<string, string> = {
    code: outcome.error.code,
    message: outcome.error.message,
  }
  if (outcome.error.approvalId !== undefined) payload.approvalId = outcome.error.approvalId
  return { stdout: '', stderr: JSON.stringify(payload, null, 2) }
}

function renderHuman(data: unknown): string {
  if (isStatusData(data)) {
    const sections = [renderModules(data.modules)]
    if (isApprovalArray(data.pendingApprovals) && data.pendingApprovals.length > 0) {
      sections.push('pending approvals:', ...data.pendingApprovals.map(renderApprovalLine))
    } else {
      sections.push('pending approvals: none')
    }
    return sections.join('\n')
  }
  if (isModuleRowArray(data)) return data.map(renderModuleLine).join('\n')
  if (isToolListingArray(data)) return data.map((t) => `${t.name} — ${t.description}`).join('\n')
  if (isApprovalArray(data)) return data.map(renderApprovalLine).join('\n')
  return JSON.stringify(data, null, 2)
}

function renderModules(modules: unknown): string {
  if (isModuleRowArray(modules)) return modules.map(renderModuleLine).join('\n')
  return JSON.stringify(modules, null, 2)
}

type ModuleRow = { id: string; name: string; version: string; tools: string[]; active: boolean }

function renderModuleLine(module: ModuleRow): string {
  const state = module.active ? 'active' : 'INACTIVE'
  return `${module.id.padEnd(20)} ${state.padEnd(9)} ${module.name} ${module.version} — ${module.tools.length} tools`
}

function renderApprovalLine(approval: {
  id: string
  toolName: string
  principalId: string
  status: string
}): string {
  return `${approval.id}  ${approval.status}  ${approval.toolName}  by ${approval.principalId}`
}

function isModuleRow(value: unknown): value is ModuleRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModuleRow).id === 'string' &&
    typeof (value as ModuleRow).version === 'string' &&
    Array.isArray((value as ModuleRow).tools) &&
    typeof (value as ModuleRow).active === 'boolean'
  )
}

function isModuleRowArray(value: unknown): value is ModuleRow[] {
  return Array.isArray(value) && value.every(isModuleRow)
}

function isToolListingArray(value: unknown): value is Array<{ name: string; description: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as { name?: unknown }).name === 'string' &&
        typeof (t as { description?: unknown }).description === 'string',
    )
  )
}

function isApprovalArray(
  value: unknown,
): value is Array<{ id: string; toolName: string; principalId: string; status: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (a) =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as { id?: unknown }).id === 'string' &&
        typeof (a as { toolName?: unknown }).toolName === 'string' &&
        typeof (a as { status?: unknown }).status === 'string',
    )
  )
}

function isStatusData(value: unknown): value is { modules: unknown; pendingApprovals: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'modules' in value &&
    Array.isArray((value as { pendingApprovals?: unknown }).pendingApprovals)
  )
}
