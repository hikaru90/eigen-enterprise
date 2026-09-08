import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  assertTransition,
  canTransition,
  invalidRunState,
  runInProgressError,
  type DevAgentRunStatus,
} from './state'

describe('dev-agent run state machine', () => {
  it('allows exactly the lifecycle edges', () => {
    const allowed: Array<[DevAgentRunStatus, DevAgentRunStatus]> = [
      ['dispatched', 'running'],
      ['running', 'green'],
      ['running', 'red'],
      ['running', 'failed'],
      ['running', 'aborted'],
      ['green', 'merged'],
      ['green', 'aborted'],
      ['red', 'aborted'],
      ['failed', 'aborted'],
    ]
    for (const [from, to] of allowed) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true)
      expect(() => assertTransition(from, to)).not.toThrow()
    }
  })

  it('rejects every shortcut and post-terminal transition', () => {
    const rejected: Array<[DevAgentRunStatus, DevAgentRunStatus]> = [
      ['dispatched', 'green'],
      ['dispatched', 'red'],
      ['dispatched', 'failed'],
      ['dispatched', 'merged'],
      ['dispatched', 'aborted'],
      ['running', 'merged'],
      ['running', 'running'],
      ['green', 'running'],
      ['green', 'green'],
      ['red', 'green'],
      ['red', 'merged'],
      ['failed', 'green'],
      ['failed', 'merged'],
      ['merged', 'aborted'],
      ['merged', 'running'],
      ['aborted', 'running'],
      ['aborted', 'merged'],
      ['aborted', 'aborted'],
    ]
    for (const [from, to] of rejected) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false)
      expect(() => assertTransition(from, to)).toThrow(/illegal dev-agent run transition/)
    }
  })

  it('holds the sandbox slot only in dispatched|running; terminal states are merged|aborted', () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(['dispatched', 'running'])
    expect(TERMINAL_RUN_STATUSES).toEqual(['merged', 'aborted'])
  })
})

describe('dev-agent domain errors', () => {
  it('run_in_progress is a KernelError carrying the module code', () => {
    const err = runInProgressError('run-1')
    expect(err).toBeInstanceOf(KernelError)
    expect(err.code).toBe('run_in_progress')
    expect(err.message).toContain('run-1')
  })

  it('invalidRunState fails loud with invalid_input', () => {
    const err = invalidRunState('nope')
    expect(err).toBeInstanceOf(KernelError)
    expect(err.code).toBe('invalid_input')
  })
})
