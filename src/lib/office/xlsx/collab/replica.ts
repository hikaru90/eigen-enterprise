import type { LogBody, WireImages } from './protocol'
import { withSeed } from '../ids'
import { applyOp, type OpResult } from '../ops'
import { XlsxError, type Images, type Workbook } from '../workbook'
import { fromBase64, fromWireValue, toBase64 } from './protocol'

/**
 * Applying log entries to a workbook — the same code in every replica (the
 * grids, the server's copy, the agent's tools), so the same entries give the
 * same workbook. A change applies all its operations or none, with its ids
 * and salts drawn from its own seed (../ids.ts) so every replica writes the
 * same bytes; an undo, or a change the server logged as its result, puts
 * the recorded parts back.
 */

export type Step = { before: Images; after: Images }
export type Applied = { result: OpResult; step: Step }

/** Applies `body` (throws and changes nothing when it can't). `seed`: the change's id (client and change id). */
export function applyBody(wb: Workbook, body: LogBody, seed: string): Applied {
  if (body.kind !== 'change') return restoreParts(wb, fromWire(body.images))
  const ops = fromWireValue(body.ops)
  const before: Images = new Map()
  const sheets = new Set<string>()
  let focus: string | undefined
  let created: string | undefined
  try {
    withSeed(seed, () => {
      for (const op of ops) {
        const { result, images } = applyOp(wb, op, { acceptLosses: body.acceptLosses })
        for (const [part, img] of images.before) if (!before.has(part)) before.set(part, img)
        for (const s of result.sheets) sheets.add(s)
        if (result.focus) focus = result.focus
        if (result.created) created = result.created
      }
    })
  } catch (err) {
    wb.restore(before)
    throw err
  }
  const result: OpResult = {
    sheets: [...sheets],
    ...(focus ? { focus } : {}),
    ...(created ? { created } : {}),
  }
  return { result, step: { before, after: imagesNow(wb, [...before.keys()]) } }
}

/** The seed of an entry's (or a pending change's) ids. */
export const seedOf = (clientId: string, opId: string) => `${clientId}\u0000${opId}`

/** Puts `images` back (an undo), recording the parts as they were. */
export function restoreParts(wb: Workbook, images: Images): Applied {
  wb.begin()
  for (const part of images.keys()) wb.touch(part)
  wb.restore(images)
  const step = wb.end()
  return {
    result: { sheets: wb.sheets().map((s) => s.name) },
    step,
  }
}

function imagesNow(wb: Workbook, parts: string[]): Images {
  wb.begin()
  for (const part of parts) wb.touch(part)
  return wb.end().after
}

// ---------------------------------------------------------------------------
// Images on the wire

/** An undo carries at most this much (the parts it restores): a bigger one is refused, never cut. */
export const MAX_REVERT_BYTES = 4 * 1024 * 1024

export function toWire(images: Images): WireImages {
  const out: WireImages = {}
  let total = 0
  for (const [part, img] of images) {
    if (!img.exists) out[part] = { exists: false }
    else {
      total += img.bytes.byteLength
      out[part] = { exists: true, contentType: img.contentType, data: toBase64(img.bytes) }
    }
  }
  if (total > MAX_REVERT_BYTES)
    throw new XlsxError('This change is too large to undo or share while the file is open for co-editing.')
  return out
}

export function fromWire(images: WireImages): Images {
  const out: Images = new Map()
  for (const [part, img] of Object.entries(images)) {
    if (!part.startsWith('/')) throw new XlsxError(`An undo names “${part}”, which is not a part of the workbook.`)
    out.set(part, img.exists ? { exists: true, contentType: img.contentType, bytes: fromBase64(img.data) } : { exists: false })
  }
  return out
}
