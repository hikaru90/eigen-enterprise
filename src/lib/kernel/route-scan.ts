import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * Static route scanner for the UI-parity gate (plan/phase-company-brain.md
 * CB4). Test-time only: it parses route files with the TypeScript compiler
 * (syntax only: no type checker, no server, no DB) and lists every mutating
 * entry point:
 *
 *   - `+server.ts`: each exported POST / PUT / PATCH / DELETE, and `fallback`
 *     (it answers every method without its own handler);
 *   - `+page.server.ts`: each key of the exported `actions` object, followed
 *     through local consts, imports (relative and `$lib`) and re-exports.
 *
 * The parse is structural (exports and object keys), never a guess at meaning.
 * Anything it cannot list statically (a spread, a call, a package import)
 * throws, so a new shape fails the gate instead of slipping past it.
 */

export const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'fallback'] as const

/** Reads a file by its path relative to the scanned root (the app's `src`); throws when missing. */
export type SourceReader = (file: string) => string

const MAX_DEPTH = 8

type Binding = { file: string; source: ts.SourceFile; init: ts.Expression }

function parse(file: string, read: SourceReader): ts.SourceFile {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

function moduleSpecifierOf(node: ts.ExportDeclaration | ts.ImportDeclaration): null | string {
  return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null
}

/**
 * The module a specifier names, as a path relative to the reader's root:
 * relative specifiers and the `$lib` alias (`lib/`). Anything else (a package)
 * throws: the scanner never guesses.
 */
function resolveModule(from: string, specifier: string, read: SourceReader): string {
  let base: string
  if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
  } else if (specifier === '$lib' || specifier.startsWith('$lib/')) {
    base = path.posix.normalize(`lib${specifier.slice('$lib'.length)}`)
  } else {
    throw new Error(`route-scan: cannot follow '${specifier}' from ${from} (not relative or $lib)`)
  }
  for (const candidate of [`${base}.ts`, `${base}.js`, base, `${base}/index.ts`]) {
    try {
      read(candidate)
      return candidate
    } catch {
      // not this candidate; try the next resolution
    }
  }
  throw new Error(`route-scan: cannot follow '${specifier}' from ${from} (no such module)`)
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** Every exported value name of a module (declared, re-exported, star-exported). */
function exportedNames(file: string, read: SourceReader, depth = 0): Set<string> {
  if (depth > MAX_DEPTH) throw new Error(`route-scan: re-export chain too deep at ${file}`)
  const names = new Set<string>()
  for (const statement of parse(file, read).statements) {
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          throw new Error(`route-scan: cannot read a destructured export statically in ${file}`)
        }
        names.add(decl.name.text)
      }
    } else if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name) {
      names.add(statement.name.text)
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const specifier = moduleSpecifierOf(statement)
      const clause = statement.exportClause
      if (clause === undefined) {
        if (specifier === null) throw new Error(`route-scan: cannot follow a bare star export in ${file}`)
        for (const name of exportedNames(resolveModule(file, specifier, read), read, depth + 1)) {
          names.add(name)
        }
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) if (!element.isTypeOnly) names.add(element.name.text)
      } else {
        throw new Error(`route-scan: cannot read a namespace re-export statically in ${file}`)
      }
    }
  }
  return names
}

/** The initializer a name is bound to in a file: a local const, or an import followed to its module. */
function bindingOf(file: string, name: string, read: SourceReader, depth: number): Binding {
  if (depth > MAX_DEPTH) throw new Error(`route-scan: binding chain too deep at ${file}`)
  const source = parse(file, read)
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          return { file, init: decl.initializer, source }
        }
      }
    }
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly !== true) {
      const named = statement.importClause?.namedBindings
      const specifier = moduleSpecifierOf(statement)
      if (named === undefined || !ts.isNamedImports(named) || specifier === null) continue
      for (const element of named.elements) {
        if (element.name.text !== name) continue
        const imported = (element.propertyName ?? element.name).text
        return exportedBindingOf(resolveModule(file, specifier, read), imported, read, depth + 1)
      }
    }
  }
  throw new Error(`route-scan: cannot resolve '${name}' statically in ${file}`)
}

/** The initializer behind an exported name of a module (declared, re-exported or star-exported). */
function exportedBindingOf(file: string, name: string, read: SourceReader, depth: number): Binding {
  if (depth > MAX_DEPTH) throw new Error(`route-scan: re-export chain too deep at ${file}`)
  const source = parse(file, read)
  const stars: string[] = []
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          return { file, init: decl.initializer, source }
        }
      }
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const specifier = moduleSpecifierOf(statement)
      const clause = statement.exportClause
      if (clause === undefined && specifier !== null) stars.push(specifier)
      if (clause === undefined || !ts.isNamedExports(clause)) continue
      for (const element of clause.elements) {
        if (element.isTypeOnly || element.name.text !== name) continue
        const local = (element.propertyName ?? element.name).text
        return specifier === null
          ? bindingOf(file, local, read, depth + 1)
          : exportedBindingOf(resolveModule(file, specifier, read), local, read, depth + 1)
      }
    }
  }
  for (const specifier of stars) {
    const target = resolveModule(file, specifier, read)
    if (exportedNames(target, read, depth + 1).has(name)) {
      return exportedBindingOf(target, name, read, depth + 1)
    }
  }
  throw new Error(`route-scan: cannot resolve export '${name}' statically in ${file}`)
}

function propertyName(name: ts.PropertyName, file: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  throw new Error(`route-scan: cannot list a computed action name statically in ${file}`)
}

/** The keys of an actions object, following identifiers to the object literal they name. */
function actionKeys(binding: Binding, read: SourceReader, depth = 0): string[] {
  if (depth > MAX_DEPTH) throw new Error(`route-scan: binding chain too deep at ${binding.file}`)
  const expr = unwrap(binding.init)
  if (ts.isIdentifier(expr)) {
    return actionKeys(bindingOf(binding.file, expr.text, read, depth + 1), read, depth + 1)
  }
  if (!ts.isObjectLiteralExpression(expr)) {
    throw new Error(`route-scan: cannot list actions statically in ${binding.file} (not an object literal)`)
  }
  return expr.properties.map((prop) => {
    if (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
      return propertyName(prop.name, binding.file)
    }
    if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text
    throw new Error(`route-scan: cannot list actions statically in ${binding.file} (spread or accessor)`)
  })
}

/**
 * The mutating entry points of one route file: method names for `+server.ts`
 * (`POST`, `DELETE`, …), `?/<action>` for `+page.server.ts`. Sorted.
 */
export function entryPointsOf(file: string, read: SourceReader): string[] {
  const names = exportedNames(file, read)
  const base = path.posix.basename(file)
  if (base.startsWith('+server.')) {
    return MUTATING_METHODS.filter((m) => names.has(m)).sort()
  }
  if (base.startsWith('+page.server.')) {
    if (!names.has('actions')) return []
    return actionKeys(exportedBindingOf(file, 'actions', read, 0), read)
      .map((a) => `?/${a}`)
      .sort()
  }
  throw new Error(`route-scan: not a route handler file: ${file}`)
}

/** The route id of a route file (`routes/api/x/+server.ts` → `/api/x`). */
function routeIdOf(file: string): string {
  const dir = path.posix.dirname(file)
  return dir === 'routes' ? '/' : `/${dir.slice('routes/'.length)}`
}

const ROUTE_HANDLER_FILES = new Set(['+page.server.js', '+page.server.ts', '+server.js', '+server.ts'])

function walk(root: string, dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(root, rel))
    else if (ROUTE_HANDLER_FILES.has(entry.name)) out.push(rel)
  }
  return out
}

/**
 * Every mutating entry point of the app, as `<route id> <entry>`:
 * `/api/drive/files/[id] DELETE`, `/(nucleus)/settings/members ?/remove`.
 * `srcRoot` is the app's `src` directory (routes under `routes/`, `$lib` =
 * `lib/`). Sorted, unique.
 */
export function scanRoutes(srcRoot: string): string[] {
  const read: SourceReader = (file) => readFileSync(path.join(srcRoot, file), 'utf8')
  const keys: string[] = []
  for (const file of walk(srcRoot, 'routes')) {
    for (const entry of entryPointsOf(file, read)) keys.push(`${routeIdOf(file)} ${entry}`)
  }
  return [...new Set(keys)].sort()
}
