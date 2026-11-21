import { z } from 'zod'
import type { AgentMetaTool, AgentMetaToolContext } from '$lib/kernel/agent-runtime'
import { KernelError } from '$lib/kernel/errors'
import type { ActivationStore } from '$lib/kernel/modules'
import type { KernelRegistry } from '$lib/kernel/registry'
import type { ToolDescriptor } from '$lib/kernel/types'
import { CliArgsError, parseCliArgs, type ParsedCliArgs } from './args'
import { executeCommand, validateParsedCommand, type CliCommandContext, type CliRegistry } from './commands'

/**
 * The company brain's hands on the ee CLI (plan/shared-memory-voice-agent-tools.md
 * §3): ONE model-facing tool, `ee`, that takes the CLI's own words and runs
 * them through the CLI's own command handlers (src/cli/commands.ts) and the
 * kernel registry — in process, no shell, no MCP hop. It reaches every
 * registry tool the asking person may run, including ones the model is not
 * handed directly, and keeps the model's context small: discovery is on
 * demand (`tool namespaces` → `tool list --namespace` → `tool help <name>` for
 * the schema), never every schema up front.
 *
 * No escalation, by construction:
 * - the principal is the run's delegated person (CB3); `--principal` is refused;
 * - `tool run` (and module / approvals commands, which are kernel tools) go
 *   through KernelRegistry.execute: the same activation gate, role check,
 *   approval gate, input validation, audit and RLS scope as a direct call;
 * - the agent's tool scope holds (a guarded registry view refuses tools outside it);
 * - discovery shows only tools within the person's reach;
 * - errors are thrown, so the engine turns them into the same structured tool
 *   error / approval card a direct call gets.
 */

export const EE_AGENT_TOOL_NAME = 'ee'

const eeInput = z
  .object({
    args: z.array(z.string()).min(1),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const SUMMARY = [
  'The eigenEnterprise CLI (ee), run as the person you are talking with: every company tool they may use, also ones you are not offered directly. Same permissions, approvals and audit as calling the tool directly.',
  'Find a tool: args ["tool","namespaces"] → ["tool","list","--namespace","<ns>"] (names + one line each) → ["tool","help","<tool.name>"] (its input schema).',
  'Run it: args ["tool","run","<tool.name>"] with `input` = the tool’s JSON input object.',
  'Also: ["module","list"], ["approvals","list"] (what the person may see).',
].join(' ')

const INPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    args: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'The ee command words, e.g. ["tool","help","reminders.list"] or ["tool","run","drive.list"].',
    },
    input: {
      type: 'object',
      additionalProperties: true,
      description: 'For ["tool","run",…]: the tool’s input as a JSON object ({} when it takes none).',
    },
  },
  required: ['args'],
  additionalProperties: false,
} as const

export type EeAgentToolDeps = {
  registry: KernelRegistry
  /** Module activation (the kernel's ActivationStore): listings show active-module tools only. */
  activations: Pick<ActivationStore, 'get'>
}

export function createEeAgentTool(deps: EeAgentToolDeps): AgentMetaTool {
  return {
    listing: { name: EE_AGENT_TOOL_NAME, summary: SUMMARY, inputJsonSchema: INPUT_JSON_SCHEMA },
    execute: (input, ctx) => runEe(deps, input, ctx),
  }
}

async function runEe(deps: EeAgentToolDeps, rawInput: unknown, ctx: AgentMetaToolContext): Promise<unknown> {
  const parsedInput = eeInput.safeParse(rawInput)
  if (!parsedInput.success) {
    const detail = parsedInput.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')
    throw new KernelError('invalid_input', `invalid input for tool ee: ${detail}. ${USAGE}`)
  }
  const { args: words, input } = parsedInput.data
  const args = parseEeWords(words, input)

  if (args.flags.principal !== undefined) {
    throw new KernelError(
      'permission_denied',
      'ee through the brain always runs as the person you are talking with; --principal is not available',
    )
  }
  if (args.group === 'openapi') {
    throw new KernelError('invalid_input', `ee openapi (every tool's schema at once) is not available to the brain. ${USAGE}`)
  }

  const inScope = (tool: Pick<ToolDescriptor, 'module'>) =>
    ctx.toolScope === 'all' || ctx.toolScope.modules.includes(tool.module)
  const mayRun = (tool: ToolDescriptor) =>
    inScope(tool) && tool.permission.roles.some((role) => ctx.principal.roles.includes(role))

  const commandCtx: CliCommandContext = {
    registry: scopeGuarded(deps.registry, inScope),
    activations: deps.activations,
    principal: ctx.principal,
    requestId: ctx.requestId,
    discovery: { mayRun, listSchemas: false },
  }
  return executeCommand(commandCtx, args)
}

const USAGE =
  'Use args like ["tool","namespaces"], ["tool","list","--namespace","drive"], ["tool","help","drive.list"], or ["tool","run","drive.list"] with input {}.'

/** The CLI's own parser + shape validation; `input` becomes the command's --input. Usage errors are invalid_input. */
function parseEeWords(words: string[], input: Record<string, unknown> | undefined): ParsedCliArgs {
  try {
    const args = parseCliArgs(words)
    if (input !== undefined) {
      if (args.flags.input !== undefined) {
        throw new CliArgsError('give the tool input either as `input` or as --input, not both')
      }
      args.flags.input = JSON.stringify(input)
    }
    validateParsedCommand(args)
    return args
  } catch (err) {
    if (err instanceof CliArgsError) {
      // The terminal usage block names terminal flags (--json); the brain gets its own.
      const first = err.message.split('\n')[0]
      throw new KernelError('invalid_input', `ee: ${first}. ${USAGE}`)
    }
    throw err
  }
}

/**
 * The registry as the agent's tool scope allows it: execute() refuses a tool
 * outside the scope (the direct surface never offers one); everything else
 * passes straight through — the registry itself still gates the call.
 */
function scopeGuarded(registry: KernelRegistry, inScope: (tool: Pick<ToolDescriptor, 'module'>) => boolean): CliRegistry {
  return {
    execute: async (name, input, toolCtx) => {
      const tool = registry.get(name)
      if (tool && !inScope(tool)) {
        throw new KernelError('permission_denied', `${name} is outside this agent’s tool scope`)
      }
      return registry.execute(name, input, toolCtx)
    },
    list: (filter) => registry.list(filter),
    get: (name) => registry.get(name),
    getApprovalStore: () => registry.getApprovalStore(),
  }
}
