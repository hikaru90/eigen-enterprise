import type { KernelEvent } from './events'

/** CloudEvents 1.0 envelope (`principalid` is a kernel extension attribute). */
export type CloudEvent<T = unknown> = {
  specversion: '1.0'
  id: string
  source: string
  type: string
  /** RFC 3339 timestamp. */
  time: string
  datacontenttype?: 'application/json'
  data?: T
  principalid?: string
}

/**
 * Map a KernelEvent to a spec-compliant CloudEvents 1.0 envelope.
 * `source` is explicit at call sites — no implicit defaults.
 */
export function toCloudEvent(event: KernelEvent, source: string): CloudEvent {
  if (!source || source.trim() === '') {
    throw new Error('toCloudEvent: source is required and must be non-empty')
  }
  const ce: CloudEvent = {
    specversion: '1.0',
    id: event.id,
    source,
    type: event.type,
    time: event.ts,
  }
  if (event.payload !== undefined) {
    ce.data = event.payload
    ce.datacontenttype = 'application/json'
  }
  if (event.principalId !== undefined) {
    ce.principalid = event.principalId
  }
  return ce
}

/**
 * Event type convention: `com.eigenenterprise.<module>.<name>`.
 */
export function eventType(module: string, name: string): string {
  if (!module || module.trim() === '' || !name || name.trim() === '') {
    throw new Error('eventType: module and name must be non-empty')
  }
  return `com.eigenenterprise.${module}.${name}`
}
