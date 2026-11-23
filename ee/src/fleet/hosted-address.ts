import { z } from 'zod'
import { hostedAddressV1, type HostedAddressV1 } from './protocol.ts'

/**
 * The company's free hosted address (plan/hosted-address.md H5) as the last poll delivered it, plus
 * its provenance: `fleetSiteHost` is the public host the fleet itself added (null = it added none,
 * or the owner's own domain displaced it). Only a host the fleet added is ever removed by the fleet.
 * One file under ee's state dir (PATHS.fleetHostedAddress), written atomically; absent = nothing.
 */

const fileV1 = z
  .object({
    version: z.literal(1),
    hostedAddress: hostedAddressV1.nullable(),
    fleetSiteHost: z.string().min(1).max(253).nullable(),
  })
  .strict()

export type HostedAddressRecord = { hostedAddress: HostedAddressV1 | null; fleetSiteHost: string | null }

export type HostedAddressFiles = {
  readFile(path: string): Promise<string | null>
  /** Durable atomic write (System.writeFile). */
  writeFile(path: string, content: string, mode?: number): Promise<void>
  remove(path: string): Promise<void>
}

const EMPTY: HostedAddressRecord = { hostedAddress: null, fleetSiteHost: null }

/** The stored record; no file = nothing. A file that doesn't parse throws, naming it (it holds provenance: never guessed). */
export async function readHostedAddress(f: Pick<HostedAddressFiles, 'readFile'>, path: string): Promise<HostedAddressRecord> {
  const raw = await f.readFile(path)
  if (raw === null) return { ...EMPTY }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`${path} is not JSON`)
  }
  const parsed = fileV1.safeParse(json)
  if (!parsed.success) throw new Error(`${path} is not a hosted address file: ${parsed.error.message}`)
  return { hostedAddress: parsed.data.hostedAddress, fleetSiteHost: parsed.data.fleetSiteHost }
}

/** Store the record; an empty one removes the file. Written only when it changed (returns whether it did). */
export async function writeHostedAddress(f: HostedAddressFiles, path: string, record: HostedAddressRecord): Promise<boolean> {
  const have = await readHostedAddress(f, path)
  if (JSON.stringify(have) === JSON.stringify({ hostedAddress: record.hostedAddress, fleetSiteHost: record.fleetSiteHost })) return false
  if (record.hostedAddress === null && record.fleetSiteHost === null) {
    await f.remove(path)
    return true
  }
  await f.writeFile(path, JSON.stringify({ version: 1, hostedAddress: record.hostedAddress, fleetSiteHost: record.fleetSiteHost }, null, 2) + '\n', 0o644)
  return true
}
