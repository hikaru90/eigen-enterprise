import type { LogBody, WireImages } from './protocol'
import { applyOp, type OpResult } from '../ops'
import { XlsxError, type Images, type Workbook } from '../workbook'

/**
 * Applying log entries to a workbook — the same code in every replica (the
 * grids, the server's copy, the agent's tools), so the same entries give the
 * same workbook. A change applies all its operations or none; an undo puts
 * the recorded parts back.
 */

export type Step = { before: Images; after: Images }
export type Applied = { result: OpResult; step: Step }

/** Applies `body` (throws and changes nothing when it can't). */
export function applyBody(wb: Workbook, body: LogBody): Applied {
  if (body.kind === 'revert') return restoreParts(wb, fromWire(body.images))
  const before: Images = new Map()
  const sheets = new Set<string>()
  let focus: string | undefined
  try {
    for (const op of body.ops) {
      const { result, images } = applyOp(wb, op, { acceptLosses: body.acceptLosses })
      for (const [part, img] of images.before) if (!before.has(part)) before.set(part, img)
      for (const s of result.sheets) sheets.add(s)
      if (result.focus) focus = result.focus
    }
  } catch (err) {
    wb.restore(before)
    throw err
  }
  const result: OpResult = focus ? { sheets: [...sheets], focus } : { sheets: [...sheets] }
  return { result, step: { before, after: imagesNow(wb, [...before.keys()]) } }
}

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

const CHUNK = 0x8000

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

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
    throw new XlsxError('This change is too large to undo while the file is open for co-editing.')
  return out
}

export function fromWire(images: WireImages): Images {
  const out: Images = new Map()
  for (const [part, img] of Object.entries(images)) {
    if (typeof part !== 'string' || !part.startsWith('/'))
      throw new XlsxError(`An undo names “${part}”, which is not a part of the workbook.`)
    out.set(part, img.exists ? { exists: true, contentType: img.contentType, bytes: fromBase64(img.data) } : { exists: false })
  }
  return out
}
