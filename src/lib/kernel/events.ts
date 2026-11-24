import { randomBytes } from 'node:crypto'
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
/**
 * A time-ordered event id (UUID version 7) that is strictly increasing in this
 * process, also for events emitted within one millisecond: a 12-bit counter in
 * rand_a takes the place of randomness, and when it runs out the timestamp moves
 * on by one. Readers order kernel_events by (ts, id) (module event delivery,
 * plan/phase-upgrades-u2.md §4.4), so ties must follow emission order; with
 * random ids two events of one millisecond came out in random order.
 */
let lastMs = 0
let counter = 0
export function nextEventId(now: number = Date.now()): { id: string; ms: number } {
  if (now > lastMs) {
    lastMs = now
    counter = randomBytes(2).readUInt16BE(0) & 0x3ff // start low: room for 3k more in this ms
  } else if (++counter > 0xfff) {
    lastMs += 1
    counter = 0
  }
  const bytes = randomBytes(16)
  bytes.writeUIntBE(lastMs, 0, 6) // 48-bit unix ms
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f) // version 7 + counter high nibble
  bytes[7] = counter & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f) // RFC 9562 variant
  const hex = bytes.toString('hex')
  return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, ms: lastMs }
}

export async function emitKernelEvent(
  sink: EventSink,
  partial: Omit<KernelEvent, 'id' | 'ts' | 'type'> & { type: CoreEventType } & Partial<Pick<KernelEvent, 'id' | 'ts'>>,
): Promise<KernelEvent> {
  if (!isCoreEventType(partial.type)) {
    throw new Error(
      `emitKernelEvent: "${String(partial.type)}" is not a core event type; add it to src/lib/kernel/event-catalog.ts and run npm run contract:lock`,
    )
  }
  // id and ts come from one clock reading, so (ts, id) is emission order.
  const next = partial.id === undefined || partial.ts === undefined ? nextEventId() : null
  const event: KernelEvent = {
    id: partial.id ?? next!.id,
    ts: partial.ts ?? new Date(next!.ms).toISOString(),
    type: partial.type,
    principalId: partial.principalId,
    source: partial.source,
    payload: partial.payload,
  }
  await sink.emit(event)
  return event
}
