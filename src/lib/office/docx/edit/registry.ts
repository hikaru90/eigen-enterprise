import type { Mark, Node as PMNode } from 'prosemirror-model'
import type { ParagraphProps, RunProps } from '../properties'

/**
 * The editor's side table from ProseMirror nodes back to the WordprocessingML
 * they came from. Nodes and marks carry only a `ref` string (attrs must stay
 * plain data: ProseMirror compares them deeply); the entry holds the source
 * element and the node(s) as first built, so the serializer can tell an
 * untouched paragraph, run or link (written back as its original XML) from
 * an edited one (rewritten from the original, keeping what we don't model).
 *
 * Refs carry a per-editor prefix: content pasted from another editor never
 * resolves to this document's elements.
 */

export type ParagraphEntry = {
  kind: 'paragraph'
  el: Element
  /** The node as built from `el`; null until built. */
  node: PMNode | null
  /** w:pPr/w:sectPr: the paragraph ends a section. */
  sectPr: Element | null
  /** Direct properties as written (what the editor does not change: spacing, borders, tabs, …). */
  direct: ParagraphProps
}
export type RunEntry = {
  kind: 'run'
  el: Element
  /** The run's inline nodes as first built (text, tabs, breaks, atoms). */
  nodes: PMNode[]
  /** The formatting marks its w:rPr gave (bold, size, …), for a minimal w:rPr rewrite. */
  marks: readonly Mark[]
  /** Direct run properties as written (the look of what no mark expresses: caps, spacing, …). */
  direct: RunProps
}
export type LinkEntry = { kind: 'link'; el: Element; nodes: PMNode[] }
/** Elements the editor carries unchanged: fields, bookmarks, content controls, tracked changes, … */
export type OpaqueEntry = { kind: 'opaque'; els: Element[] }
/** A single source element (w:tab, w:br, w:drawing, w:sectPr, an opaque block). */
export type ElementEntry = { kind: 'element'; el: Element }
export type TableEntry = { kind: 'table'; el: Element; node: PMNode | null; gridTwips: number[] }
export type RowEntry = { kind: 'row'; el: Element; node: PMNode | null }
/** `css`: the cell's resolved borders, margins and shading (table style included), for the editor's look. */
export type CellEntry = { kind: 'cell'; el: Element; node: PMNode | null; css: string }

export type Entry = ParagraphEntry | RunEntry | LinkEntry | OpaqueEntry | ElementEntry | TableEntry | RowEntry | CellEntry

export class SourceRegistry {
  private readonly entries = new Map<string, Entry>()
  private n = 0
  readonly prefix: string

  constructor(prefix = `d${Math.random().toString(36).slice(2, 8)}-`) {
    this.prefix = prefix
  }

  add(entry: Entry): string {
    const ref = `${this.prefix}${++this.n}`
    this.entries.set(ref, entry)
    return ref
  }

  get(ref: string | null | undefined): Entry | undefined {
    return ref ? this.entries.get(ref) : undefined
  }

  /** The entry of `ref` when it is of `kind` (refs from elsewhere resolve to nothing). */
  of<K extends Entry['kind']>(ref: string | null | undefined, kind: K): Extract<Entry, { kind: K }> | undefined {
    const e = this.get(ref)
    return e && e.kind === kind ? (e as Extract<Entry, { kind: K }>) : undefined
  }

  has(ref: string | null | undefined): boolean {
    return this.get(ref) !== undefined
  }
}
