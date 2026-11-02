/// <reference types="vite/client" />
import { pickerIndexSchema, validatePickerNodes, type PickerNode, type PickerTokenSet } from './picker-index'

/**
 * Runtime loader for the precompiled brand-picker index (plan/phase-brand-picker.md
 * §3.2–3.3). `picker-index.json` is written by the preview renderer (B2b); it is
 * bundled as a module asset (like the corpus) and validated fail-loud at first
 * use — schema + structure + previews. A missing or invalid index is an error,
 * never an empty picker.
 *
 * Source selection: `BRAND_PICKER_INDEX=fixture` serves the small test fixture
 * (e2e harness only, set explicitly in playwright.config.ts); unset = the built
 * index. Any other value fails loud.
 */

const built = import.meta.glob<unknown>('./picker-index.json', { eager: true, import: 'default' })
const fixtures = import.meta.glob<unknown>('./test-fixtures/picker-fixture.json', { eager: true, import: 'default' })

export type PickerIndexSource = 'built' | 'fixture'

export type PickerTree = {
  nodes: PickerNode[]
  get(id: string): PickerNode | null
  /** Children in index order; `null` = the genres. */
  children(parentId: string | null): PickerNode[]
  /** Root → node, inclusive. */
  trail(id: string): PickerNode[]
}

export function parsePickerIndex(raw: unknown, source: string): PickerTree {
  const parsed = pickerIndexSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`brand picker index (${source}) is invalid: ${issues}`)
  }
  const nodes = parsed.data.nodes
  const errors = validatePickerNodes(nodes, { requirePreviews: true })
  if (errors.length > 0) throw new Error(`brand picker index (${source}) is invalid: ${errors.join('; ')}`)

  const byId = new Map(nodes.map((n) => [n.id, n]))
  return {
    nodes,
    get: (id) => byId.get(id) ?? null,
    children: (parentId) => nodes.filter((n) => n.parentId === parentId),
    trail(id) {
      const out: PickerNode[] = []
      let cur = byId.get(id)
      while (cur) {
        out.unshift(cur)
        cur = cur.parentId === null ? undefined : byId.get(cur.parentId)
      }
      return out
    },
  }
}

export function pickerIndexSourceFromEnv(value: string | undefined): PickerIndexSource {
  if (value === undefined || value === '') return 'built'
  if (value === 'fixture' || value === 'built') return value
  throw new Error(`BRAND_PICKER_INDEX must be "built" or "fixture", got "${value}"`)
}

const cache = new Map<PickerIndexSource, PickerTree>()

export function loadPickerIndex(source: PickerIndexSource): PickerTree {
  const hit = cache.get(source)
  if (hit) return hit
  const modules = source === 'built' ? built : fixtures
  const raw = Object.values(modules)[0]
  if (raw === undefined) {
    throw new Error(
      source === 'built'
        ? 'brand picker index modules/brand/taxonomy/picker-index.json is missing — the preview renderer (B2b) writes it'
        : 'brand picker fixture modules/brand/taxonomy/test-fixtures/picker-fixture.json is missing',
    )
  }
  const tree = parsePickerIndex(raw, source === 'built' ? 'picker-index.json' : 'picker-fixture.json')
  cache.set(source, tree)
  return tree
}
loadPickerIndex.hasBuiltIndex = (): boolean => Object.keys(built).length > 0

/** The index's bare role keys → visual-set cssVars (`--role`), the shape activation checks. */
export function toVisualSetVars(tokens: PickerTokenSet): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v]))
}
