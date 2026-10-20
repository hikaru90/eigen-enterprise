import type { EventSink } from '$lib/kernel/events'
import {
  createNodeSpawnRunner,
  PiEngine,
  type EngineContext,
  type PiExecution,
  type SpawnRunner,
} from '$lib/kernel/pi-engine'
import { NodeCommandRunner, type CommandRunner } from './runner'
import { CliPiRunner } from './runner'
import { defaultDevAgentStore, type DevAgentRunStore } from './store'
import { DevAgentEngine } from './tools'

export { DEV_AGENT_TOOL_NAMES } from './tool-names'

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

export type PiEngineFactoryOptions = {
  spawnRunner?: SpawnRunner
  timeoutMs?: number
  promptBuilder?: (task: string) => string
  taskWrapper?: (task: string) => string
  cwd?: string
}

/**
 * Compose the kernel PiEngine — the hosted 'pi' LoopEngine (phase 1b) — with
 * production defaults over injected seams. Integration wiring (orchestrator,
 * not this module): `registerEngine('pi', createPiEngine())`.
 */
export function createPiEngine(options: PiEngineFactoryOptions = {}): PiEngine {
  return new PiEngine({
    spawnRunner: options.spawnRunner ?? createNodeSpawnRunner(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.promptBuilder === undefined ? {} : { promptBuilder: options.promptBuilder }),
    ...(options.taskWrapper === undefined ? {} : { taskWrapper: options.taskWrapper }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })
}

/** Ready-to-register 'pi' engine instance (production defaults). */
export const piEngine: PiEngine = createPiEngine()

export { PiEngine }
export type { EngineContext, PiExecution }
