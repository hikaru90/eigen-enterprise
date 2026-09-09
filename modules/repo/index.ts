import type { EventSink } from '$lib/kernel/events'
import { NodeCommandRunner, type CommandRunner } from './runner'
import { RepoEngine, type RepoEngineDeps } from './tools'

export const REPO_MODULE_ID = 'repo'

export { REPO_TOOL_NAMES, repoManifest } from './manifest'
export { RepoEngine, createRepoTools } from './tools'
export {
  DEFAULT_COMMAND_TIMEOUT_MS,
  NodeCommandRunner,
  OUTPUT_MAX_CHARS,
  REPO_VERIFY_TARGETS,
  TIMEOUT_EXIT_CODE,
  truncateOutput,
  verifyWorktree,
} from './runner'
export type {
  CommandResult,
  CommandRunner,
  CommandSpec,
  VerificationResult,
} from './runner'

export type RepoEngineOptions = {
  commands?: CommandRunner
  eventSink: EventSink
  baseCwd?: string
  timeoutMs?: number
  verify?: RepoEngineDeps['verify']
}

/** Compose a RepoEngine with production defaults over injected seams. */
export function createRepoEngine(options: RepoEngineOptions): RepoEngine {
  return new RepoEngine({
    commands: options.commands ?? new NodeCommandRunner(),
    eventSink: options.eventSink,
    ...(options.baseCwd === undefined ? {} : { baseCwd: options.baseCwd }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.verify === undefined ? {} : { verify: options.verify }),
  })
}
