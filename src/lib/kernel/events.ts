import { randomUUID } from 'node:crypto'

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
 */
export async function emitKernelEvent(
  sink: EventSink,
  partial: Omit<KernelEvent, 'id' | 'ts'> & Partial<Pick<KernelEvent, 'id' | 'ts'>>,
): Promise<KernelEvent> {
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
