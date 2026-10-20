import { z } from 'zod'
import { PATHS } from './paths.ts'
import type { System } from './system.ts'
import { deployRecordSchema } from './deploys.ts'

/**
 * ee's runtime state: what is ACTUALLY live, observed and recorded. Never
 * authoritative — the company repo is (D4). Losing this file costs a redeploy,
 * never data.
 */

const slotState = z.object({
  release: z.string(),
  fingerprint: z.string(),
  port: z.number().int(),
})

const workloadState = z.object({
  basePort: z.number().int(),
  active: z.enum(['a', 'b']).nullable(),
  slots: z.object({ a: slotState.optional(), b: slotState.optional() }),
  /** Static workloads: the served root of the active release. */
  staticRoot: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  /** Fingerprint of the last release+config that failed its health gate (not retried until it changes). */
  failedFingerprint: z.string().nullable().default(null),
})

export const eventSchema = z.object({
  id: z.string(),
  time: z.string(),
  type: z.string(),
  workload: z.string().nullable(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
})

const journalSchema = z.object({
  version: z.literal(1),
  workloads: z.record(z.string(), workloadState),
  caddyFingerprint: z.string().nullable(),
  appliedRev: z.string().nullable(),
  events: z.array(eventSchema),
  /** Deploy attempts (bounded per workload); their logs live in PATHS.root/deploys. */
  deploys: z.array(deployRecordSchema).default([]),
})

export type Journal = z.infer<typeof journalSchema>
export type WorkloadState = z.infer<typeof workloadState>
export type EeEvent = z.infer<typeof eventSchema>

export const FIRST_PORT = 4100
const MAX_EVENTS = 500

export function emptyJournal(): Journal {
  return { version: 1, workloads: {}, caddyFingerprint: null, appliedRev: null, events: [], deploys: [] }
}

export async function loadJournal(sys: System): Promise<Journal> {
  const raw = await sys.readFile(PATHS.journal)
  if (raw === null) return emptyJournal()
  return journalSchema.parse(JSON.parse(raw))
}

export async function saveJournal(sys: System, j: Journal): Promise<void> {
  if (j.events.length > MAX_EVENTS) j.events = j.events.slice(-MAX_EVENTS)
  await sys.writeFile(PATHS.journal, JSON.stringify(j, null, 2) + '\n', 0o600)
}

/** Allocate two adjacent ports (slot a, slot b) the first time a workload is seen. */
export function workloadEntry(j: Journal, name: string): WorkloadState {
  const existing = j.workloads[name]
  if (existing) return existing
  const used = Object.values(j.workloads).map((w) => w.basePort)
  let base = FIRST_PORT
  while (used.includes(base)) base += 2
  const entry: WorkloadState = { basePort: base, active: null, slots: {}, staticRoot: null, lastError: null, failedFingerprint: null }
  j.workloads[name] = entry
  return entry
}
