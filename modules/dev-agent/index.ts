import type { EventSink } from '$lib/kernel/events'
import type { ModuleManifest } from '$lib/kernel/modules'
import { NodeCommandRunner, type CommandRunner } from './runner'
import { CliPiRunner } from './runner'
import { defaultDevAgentStore, type DevAgentRunStore } from './store'
import { DevAgentEngine } from './tools'

export const DEV_AGENT_MODULE_ID = 'dev-agent'

/** Tool names owned by the dev-agent module (single source of truth for the manifest). */
export const DEV_AGENT_TOOL_NAMES = [
  'dev-agent.dispatch',
  'dev-agent.status',
  'dev-agent.logs',
  'dev-agent.merge',
  'dev-agent.abort',
] as const

export const devAgentManifest: ModuleManifest = {
  id: DEV_AGENT_MODULE_ID,
  name: 'Dev Agent',
  version: '0.1.0',
  description:
    'Self-improvement agent: headless pi coding-agent runs in git worktree sandboxes, gated by a tests+typecheck verification gate and an owner-approved merge.',
  tools: [...DEV_AGENT_TOOL_NAMES],
  permissions: { roles: ['owner', 'admin', 'agent'] },
}

export type DevAgentEngineOptions = {
  store?: DevAgentRunStore
  commands?: CommandRunner
  eventSink: EventSink
  baseCwd?: string
}

/** Compose a DevAgentEngine with production defaults over injected seams. */
export function createDevAgentEngine(options: DevAgentEngineOptions): DevAgentEngine {
  const commands = options.commands ?? new NodeCommandRunner()
  return new DevAgentEngine({
    store: options.store ?? defaultDevAgentStore(),
    pi: new CliPiRunner(commands),
    commands,
    eventSink: options.eventSink,
    ...(options.baseCwd === undefined ? {} : { baseCwd: options.baseCwd }),
  })
}

export { createDevAgentTools, DevAgentEngine } from './tools'
export type { PiRunner, PiRunResult } from './runner'
