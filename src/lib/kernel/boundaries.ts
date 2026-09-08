/**
 * Static module-boundary guard (kernel-open-api.md rule 1: zero side doors).
 *
 * Module code never imports another module's code — cross-module work goes
 * through `kernelRegistry.execute()`. This detector is lint mechanics on
 * import specifiers (no semantics, no filesystem): it resolves each specifier
 * against the importing file's path and flags any that land in a DIFFERENT
 * module's tree, or in the composition root `modules/index` (a module pulling
 * in the root's wiring would close a cycle around the kernel). Files not
 * strictly inside `modules/<id>/…` (including `modules/index.ts` itself and
 * its co-located spec) are ignored.
 *
 * Covered forms: `from '…'` (static and export-from, incl. multi-line
 * imports), `import('…')`, and bare `import '…'`. Matches may also occur
 * inside comments or strings — accepted for a lint-level guard.
 */

export type CandidateFile = {
  path: string
  content: string
}

export type CrossModuleImport = {
  /** File containing the import. */
  file: string
  /** Repo-relative path the specifier resolves into (the other module's file). */
  imported: string
  /** Raw import specifier as written. */
  spec: string
}

/**
 * Declared wiring edges: cross-module imports that are structural boot
 * wiring, not side-door action calls. Every entry is reviewed policy —
 * the orchestrator is the boot stage that constructs and registers the
 * chat-gateway surface. Removing an entry requires extracting the shared
 * contract into the kernel first (plan/kernel-open-api.md §Later).
 */
export const DECLARED_WIRING_EDGES: ReadonlyMap<string, string> = new Map([
  [
    'orchestrator→chat-gateway',
    'orchestrator bootstrap/brain/allowlist-tools construct and register the gateway surface',
  ],
  [
    'orchestrator→index',
    'orchestrator bootstrap registers its tools through the composition root at a later boot stage',
  ],
])

/** Owning module id of a path strictly inside `modules/<id>/…`, else null. */
function ownerModule(path: string): string | null {
  const match = /(?:^|\/)modules\/([^/]+)\//.exec(path)
  return match?.[1] ?? null
}

/** Posix path join-and-collapse of a relative specifier against the file's dir. */
function resolveSpecifier(fromFile: string, spec: string): string {
  if (!spec.startsWith('.')) return spec
  const segments = fromFile.split('/').slice(0, -1)
  for (const segment of spec.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]\s*(?:;|$)/g,
]

function importSpecifiers(content: string): string[] {
  const specs: string[] = []
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content))) specs.push(match[1])
  }
  return specs
}

export function findCrossModuleImports(
  files: CandidateFile[],
  policy: ReadonlyMap<string, string> = DECLARED_WIRING_EDGES,
): CrossModuleImport[] {
  const violations: CrossModuleImport[] = []
  const seen = new Set<string>()
  for (const { path: file, content } of files) {
    const owner = ownerModule(file)
    if (!owner) continue
    for (const spec of importSpecifiers(content)) {
      const imported = resolveSpecifier(file, spec)
      // Bare directory targets ('../other' → modules/other) have no trailing
      // slash for the owner regex; probe with one appended.
      const other = ownerModule(imported) ?? ownerModule(`${imported}/`)
      if (!other || other === owner) continue
      if (policy.has(`${owner}→${other}`)) continue
      const key = `${file}→${spec}`
      if (seen.has(key)) continue
      seen.add(key)
      violations.push({ file, imported, spec })
    }
  }
  return violations
}
