import { KernelError, type KernelErrorCode } from '$lib/kernel/errors'

/**
 * Dev-agent run lifecycle. dispatched -> running -> (green|red|failed) ->
 * merged|aborted. Terminal states are merged and aborted. 'dispatched' has no
 * abort edge (mission: abort is allowed while running or after a terminal
 * state; the sandbox worktree does not exist before 'running').
 */
export type DevAgentRunStatus =
  | 'dispatched'
  | 'running'
  | 'green'
  | 'red'
  | 'failed'
  | 'merged'
  | 'aborted'

/** Statuses that hold the single-flight sandbox slot. */
export const ACTIVE_RUN_STATUSES: readonly DevAgentRunStatus[] = ['dispatched', 'running']

/** Statuses from which no further transition is possible. */
export const TERMINAL_RUN_STATUSES: readonly DevAgentRunStatus[] = ['merged', 'aborted']

const ALLOWED_TRANSITIONS: Record<DevAgentRunStatus, readonly DevAgentRunStatus[]> = {
  dispatched: ['running'],
  running: ['green', 'red', 'failed', 'aborted'],
  green: ['merged', 'aborted'],
  red: ['aborted'],
  failed: ['aborted'],
  merged: [],
  aborted: [],
}

export function canTransition(from: DevAgentRunStatus, to: DevAgentRunStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/** Throws loud on an illegal transition — the state machine is the guard, not the caller. */
export function assertTransition(from: DevAgentRunStatus, to: DevAgentRunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal dev-agent run transition: ${from} -> ${to}`)
  }
}

/**
 * Module-scoped kernel error code for the single-flight gate. The kernel's
 * KernelErrorCode union is closed (src/lib/kernel/errors.ts, outside this
 * workstream's file scope), so the code is attached via the same union type.
 */
export const RUN_IN_PROGRESS: KernelErrorCode = 'run_in_progress' as KernelErrorCode

export function runInProgressError(activeRunId: string): KernelError {
  return new KernelError(RUN_IN_PROGRESS, `a dev-agent run is already in progress: ${activeRunId}`)
}

/** Loud error for unknown run ids or operations against the wrong run state. */
export function invalidRunState(detail: string): KernelError {
  return new KernelError('invalid_input', detail)
}
