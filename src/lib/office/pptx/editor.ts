import type { OpcPackage } from '../ooxml/package'
import { readDeck, type Deck } from './model'
import { applyOp, type DeckOp, type OpResult } from './ops'

/**
 * A deck being edited: the package, its model (read again after every
 * change), and the undo/redo history of operations (./ops.ts). Undo and redo
 * replay the exact inverse each operation recorded, so they give back the
 * same bytes.
 */
export type DeckEditor = {
  readonly pkg: OpcPackage
  deck(): Deck
  /** Applies an operation; null when it changed nothing (no history entry). */
  apply(op: DeckOp): OpResult | null
  undo(): OpResult | null
  redo(): OpResult | null
  canUndo(): boolean
  canRedo(): boolean
  /** Counts changes (apply, undo, redo): what autosave compares. */
  version(): number
  toBytes(): Uint8Array
}

export function createDeckEditor(pkg: OpcPackage, opts: { limit?: number } = {}): DeckEditor {
  const limit = opts.limit ?? 200
  let deck = readDeck(pkg)
  let version = 0
  const undos: DeckOp[] = []
  const redos: DeckOp[] = []

  /** Applies and re-reads; an operation that leaves an unreadable deck is undone and its error thrown. */
  function step(op: DeckOp): OpResult | null {
    const result = applyOp(pkg, op)
    if (result.touched.length === 0) return null
    try {
      deck = readDeck(pkg)
    } catch (err) {
      applyOp(pkg, result.inverse)
      deck = readDeck(pkg)
      throw err
    }
    version++
    return result
  }

  return {
    pkg,
    deck: () => deck,
    apply(op) {
      const result = step(op)
      if (!result) return null
      undos.push(result.inverse)
      if (undos.length > limit) undos.shift()
      redos.length = 0
      return result
    },
    undo() {
      const op = undos.pop()
      if (!op) return null
      const result = step(op)
      if (result) redos.push(result.inverse)
      return result
    },
    redo() {
      const op = redos.pop()
      if (!op) return null
      const result = step(op)
      if (result) undos.push(result.inverse)
      return result
    },
    canUndo: () => undos.length > 0,
    canRedo: () => redos.length > 0,
    version: () => version,
    toBytes: () => pkg.toBytes(),
  }
}
