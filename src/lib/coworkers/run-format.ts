import { m } from '$lib/paraglide/messages.js'

/**
 * How a co-worker's run reads (plan/phase-ai-coworkers.md C6): its run log on
 * the profile and its rows in Needs you. The closed sets of coworkers.runs —
 * trigger, status, stop reason — each have their label (structure, no
 * interpretation).
 */

export type RunTrigger = 'mention' | 'dm' | 'assignment' | 'rhythm' | 'event'
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped'
export type RunStopReason =
  | 'thread_budget'
  | 'daily_cap'
  | 'model_error'
  | 'post_error'
  | 'turn_error'
  | 'interrupted'
  | 'unavailable'
  | 'not_member'
  | 'task_unavailable'

/** A run as coworkers.runs gives it (the fields the UI shows). */
export type RunItem = {
  id: string
  triggerKind: RunTrigger
  status: RunStatus
  stopReason: RunStopReason | null
  costUsd: number
  threadUrl: string | null
  taskUrl: string | null
  hidden: boolean
  triggeredAt: string
  endedAt: string | null
}

const TRIGGER: Record<RunTrigger, () => string> = {
  mention: m.coworkers_run_trigger_mention,
  dm: m.coworkers_run_trigger_dm,
  assignment: m.coworkers_run_trigger_assignment,
  rhythm: m.coworkers_run_trigger_rhythm,
  event: m.coworkers_run_trigger_event,
}

const STATUS: Record<RunStatus, () => string> = {
  queued: m.coworkers_run_status_queued,
  running: m.coworkers_run_status_running,
  done: m.coworkers_run_status_done,
  failed: m.coworkers_run_status_failed,
  stopped: m.coworkers_run_status_stopped,
}

const STOP: Record<RunStopReason, () => string> = {
  thread_budget: m.coworkers_run_stop_thread_budget,
  daily_cap: m.coworkers_run_stop_daily_cap,
  model_error: m.coworkers_run_stop_model_error,
  post_error: m.coworkers_run_stop_post_error,
  turn_error: m.coworkers_run_stop_turn_error,
  interrupted: m.coworkers_run_stop_interrupted,
  unavailable: m.coworkers_run_stop_unavailable,
  not_member: m.coworkers_run_stop_not_member,
  task_unavailable: m.coworkers_run_stop_task_unavailable,
}

export const triggerLabel = (t: RunTrigger) => TRIGGER[t]()

/** "Done", or "Stopped: daily cap reached". */
export const statusLabel = (r: Pick<RunItem, 'status' | 'stopReason'>) =>
  r.stopReason ? `${STATUS[r.status]()}: ${STOP[r.stopReason]()}` : STATUS[r.status]()

/** Cost to the cent below a dollar, e.g. "$0.0123" → "$0.012". */
export const costLabel = (usd: number) => m.coworkers_run_cost({ amount: usd < 1 ? usd.toFixed(3) : usd.toFixed(2) })
