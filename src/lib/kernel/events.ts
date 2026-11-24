import { randomUUID } from 'node:crypto'
import { isCoreEventType, type CoreEventType } from './event-catalog'

export type KernelEvent = {
  id: string
  /** ISO-8601 timestamp. */
  ts: string
  type: string
  principalId?: string
  /** CloudEvents `source` provenance, set by emit sites. */
  source?: string
  payload: unknown
}

export type EventSink = {
  emit(event: KernelEvent): Promise<void>
}

export class InMemoryEventSink implements EventSink {
  readonly events: KernelEvent[] = []

  async emit(event: KernelEvent): Promise<void> {
    this.events.push(event)
  }
}

/**
 * Fill in `id` and `ts`, then hand the event to the sink.
 * Pure metadata plumbing — the sink stays responsible for persistence.
 * Only a type of the core event catalog (event-catalog.ts, locked in
 * contracts/core-api.lock.json) may be emitted; any other type is refused.
 */
export async function emitKernelEvent(
  sink: EventSink,
  partial: Omit<KernelEvent, 'id' | 'ts' | 'type'> & { type: CoreEventType } & Partial<Pick<KernelEvent, 'id' | 'ts'>>,
): Promise<KernelEvent> {
  if (!isCoreEventType(partial.type)) {
    throw new Error(
      `emitKernelEvent: "${String(partial.type)}" is not a core event type; add it to src/lib/kernel/event-catalog.ts and run npm run contract:lock`,
    )
  }
  const event: KernelEvent = {
    id: partial.id ?? randomUUID(),
    ts: partial.ts ?? new Date().toISOString(),
    type: partial.type,
    principalId: partial.principalId,
    source: partial.source,
    payload: partial.payload,
  }
  await sink.emit(event)
  return event
}
