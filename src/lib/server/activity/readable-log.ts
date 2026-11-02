import type { KernelEvent } from '$lib/kernel/events'
import { FEED_EVENT_TYPES } from './kernel-events'

/**
 * The Agent → Activity log: kernel events read back as plain-language lines
 * for a non-technical owner ("who, what, outcome"). Built only from the
 * feed's metadata whitelist (tool name, ok, duration, reply length) plus the
 * tool's own `activity` sentence (the same line Overview shows). Principal
 * ids, chat ids, message text, errors and spend never leave this function.
 */

export type LogOutcome = 'done' | 'failed' | null

export type ActivityLogEntry = {
  id: string
  ts: string
  /** UTC calendar day (YYYY-MM-DD) — the grouping key. */
  day: string
  /** Module id for filtering ("agent" for the agent's own lifecycle). */
  module: string
  moduleLabel: string
  /** Who acted, in words: Agent, A team member, Telegram, System. */
  actor: string
  text: string
  outcome: LogOutcome
  /** The expandable "details": event type and metadata, no ids or content. */
  details: string[]
}

export type ActivityLogDay = { day: string; entries: ActivityLogEntry[] }

const MODULE_SOURCE_PREFIX = 'urn:eigenenterprise:module:'

const MODULE_LABELS: Record<string, string> = {
  agent: 'Agent',
  orchestrator: 'Agent',
  'chat-gateway': 'Telegram',
}

function humanize(id: string): string {
  const words = id.replace(/[_.-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function moduleLabel(id: string): string {
  return MODULE_LABELS[id] ?? humanize(id)
}

function record(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

function moduleOf(event: KernelEvent): string {
  if (event.source?.startsWith(MODULE_SOURCE_PREFIX)) {
    return event.source.slice(MODULE_SOURCE_PREFIX.length)
  }
  return 'agent'
}

function toolText(tool: string): string {
  const dot = tool.indexOf('.')
  if (dot <= 0) return `Used ${humanize(tool).toLowerCase()}`
  return `Used ${moduleLabel(tool.slice(0, dot))}: ${humanize(tool.slice(dot + 1)).toLowerCase()}`
}

/** One kernel event as a readable line. Unknown types fail loud. */
export function toLogEntry(event: KernelEvent, agentIds: ReadonlySet<string>): ActivityLogEntry {
  if (!(FEED_EVENT_TYPES as readonly string[]).includes(event.type)) {
    throw new Error(`toLogEntry: event type outside the feed whitelist: ${event.type}`)
  }
  const d = new Date(event.ts)
  if (Number.isNaN(d.getTime())) throw new Error(`toLogEntry: invalid timestamp ${event.ts}`)
  const p = record(event.payload)
  const details = [event.type]
  const module = moduleOf(event)
  const isAgent = event.principalId !== undefined && agentIds.has(event.principalId)

  let actor = 'Agent'
  let text: string
  let outcome: LogOutcome = null
  switch (event.type) {
    case 'agent.dispatched':
      text = 'Started working on a conversation'
      break
    case 'agent.replied':
      text = 'Replied in a conversation'
      outcome = 'done'
      if (typeof p.replyLength === 'number') details.push(`reply: ${p.replyLength} characters`)
      break
    case 'agent.stopped':
      text = 'Was stopped'
      break
    case 'agent.budget_exceeded':
      text = 'Hit its spending limit and did not run'
      outcome = 'failed'
      break
    case 'tool.executed': {
      const tool = typeof p.tool === 'string' ? p.tool : 'a tool'
      actor = isAgent ? 'Agent' : event.principalId ? 'A team member' : 'System'
      text = typeof p.activity === 'string' && p.activity.length > 0 ? p.activity : toolText(tool)
      outcome = p.ok === true ? 'done' : p.ok === false ? 'failed' : null
      details.push(`tool: ${tool}`)
      if (typeof p.durationMs === 'number') details.push(`took ${p.durationMs} ms`)
      break
    }
    case 'gateway.telegram.message':
      actor = 'Telegram'
      text = 'Received a message for the agent'
      break
    case 'gateway.telegram.denied':
      actor = 'Telegram'
      text = 'Refused a message from an unknown sender'
      outcome = 'failed'
      break
    default:
      throw new Error(`toLogEntry: no wording for ${event.type}`)
  }

  return {
    id: event.id,
    ts: d.toISOString(),
    day: d.toISOString().slice(0, 10),
    module,
    moduleLabel: moduleLabel(module),
    actor,
    text,
    outcome,
    details,
  }
}

/** Newest-first entries → day groups, order preserved. */
export function groupLogByDay(entries: readonly ActivityLogEntry[]): ActivityLogDay[] {
  const days: ActivityLogDay[] = []
  for (const entry of entries) {
    const last = days.at(-1)
    if (last && last.day === entry.day) last.entries.push(entry)
    else days.push({ day: entry.day, entries: [entry] })
  }
  return days
}
