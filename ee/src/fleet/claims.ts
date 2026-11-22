import { z } from 'zod'
import { domainClaimV1, type DomainClaimV1 } from './protocol.ts'

/**
 * The control plane's view of the company's domain claims (plan/domains-one-claim.md D4), as the
 * last poll delivered it: which custom hosts are verified and the exact `_ee-verify` TXT each needs.
 * Kept in one file under ee's state dir (PATHS.fleetClaims), written atomically; absent = not a
 * managed box, or nothing received yet. ee only stores and shows it; the control plane decides.
 */

const claimsFileV1 = z.object({ version: z.literal(1), claims: z.array(domainClaimV1) }).strict()

export type ClaimFiles = {
  readFile(path: string): Promise<string | null>
  /** Durable atomic write (System.writeFile). */
  writeFile(path: string, content: string, mode?: number): Promise<void>
  remove(path: string): Promise<void>
}

/** The stored claims; null when there is no file. A file that doesn't parse throws, naming it. */
export async function readClaims(f: Pick<ClaimFiles, 'readFile'>, path: string): Promise<DomainClaimV1[] | null> {
  const raw = await f.readFile(path)
  if (raw === null) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`${path} is not JSON`)
  }
  const parsed = claimsFileV1.safeParse(json)
  if (!parsed.success) throw new Error(`${path} is not a claims file: ${parsed.error.message}`)
  return parsed.data.claims
}

/**
 * Store the claims; null removes the file. Written only when they changed (returns whether they did).
 * An unreadable file is replaced by what the control plane just sent: the poll is the truth.
 */
export async function writeClaims(f: ClaimFiles, path: string, claims: DomainClaimV1[] | null): Promise<boolean> {
  const have = await readClaims(f, path).catch(() => undefined)
  if (claims === null) {
    if (have === null) return false
    await f.remove(path)
    return true
  }
  if (have !== undefined && have !== null && JSON.stringify(have) === JSON.stringify(claims)) return false
  await f.writeFile(path, JSON.stringify({ version: 1, claims }, null, 2) + '\n', 0o644)
  return true
}
