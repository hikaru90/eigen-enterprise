import { describe, expect, it } from 'vitest'
import { entryPointsOf, type SourceReader } from './route-scan'

/** An in-memory file tree for the scanner (paths relative to src/routes). */
function reader(files: Record<string, string>): SourceReader {
  return (file) => {
    const text = files[file]
    if (text === undefined) throw new Error(`no such file: ${file}`)
    return text
  }
}

describe('route scanner: mutating handlers in +server.ts', () => {
  it('finds const, function, async function and export-list forms, and ignores reads', () => {
    const files = {
      'api/x/+server.ts': `
        import type { RequestHandler } from './$types'
        export const GET: RequestHandler = async () => new Response()
        export const POST: RequestHandler = async () => new Response()
        export async function PUT() { return new Response() }
        export function PATCH() { return new Response() }
        const remove = () => new Response()
        export { remove as DELETE }
        export const OPTIONS = () => new Response()
        export const prerender = false
      `,
    }
    expect(entryPointsOf('api/x/+server.ts', reader(files))).toEqual([
      'DELETE',
      'PATCH',
      'POST',
      'PUT',
    ])
  })

  it('counts fallback (every method without its own handler) as mutating', () => {
    const files = { 'api/f/+server.ts': `export const fallback = async () => new Response()` }
    expect(entryPointsOf('api/f/+server.ts', reader(files))).toEqual(['fallback'])
  })

  it('follows re-exports, named and star, to their handlers', () => {
    const files = {
      'api/a/+server.ts': `export { POST, GET } from '../shared/handlers'`,
      'api/b/+server.ts': `export * from '../shared/handlers'`,
      'api/shared/handlers.ts': `
        export const GET = () => new Response()
        export const POST = () => new Response()
        export async function DELETE() { return new Response() }
      `,
    }
    expect(entryPointsOf('api/a/+server.ts', reader(files))).toEqual(['POST'])
    expect(entryPointsOf('api/b/+server.ts', reader(files))).toEqual(['DELETE', 'POST'])
  })

  it('fails loud on a star re-export it cannot read (a package, not a relative path)', () => {
    const files = { 'api/c/+server.ts': `export * from '$lib/server/handlers'` }
    expect(() => entryPointsOf('api/c/+server.ts', reader(files))).toThrow(/cannot follow/)
  })
})

describe('route scanner: form actions in +page.server.ts', () => {
  it('lists named and default actions of an object literal, satisfies/as included', () => {
    const files = {
      'p/+page.server.ts': `
        import type { Actions } from './$types'
        export const load = async () => ({})
        export const actions = {
          default: async () => ({}),
          save: async () => ({}),
          'mark-read': async () => ({}),
          remove,
          async archive() { return {} },
        } satisfies Actions
      `,
      'q/+page.server.ts': `export const actions: Actions = ({ go: async () => ({}) }) as Actions`,
    }
    expect(entryPointsOf('p/+page.server.ts', reader(files))).toEqual([
      '?/archive',
      '?/default',
      '?/mark-read',
      '?/remove',
      '?/save',
    ])
    expect(entryPointsOf('q/+page.server.ts', reader(files))).toEqual(['?/go'])
  })

  it('resolves actions bound to a local identifier', () => {
    const files = {
      'p/+page.server.ts': `
        const pageActions = { one: async () => ({}), two: async () => ({}) } satisfies Actions
        export const actions = pageActions
      `,
    }
    expect(entryPointsOf('p/+page.server.ts', reader(files))).toEqual(['?/one', '?/two'])
  })

  it('follows a re-exported actions object to the file that defines it', () => {
    const files = {
      'llm/byok/[provider]/+page.server.ts': `
        export const load = async () => ({})
        export { actions } from '../../+page.server'
      `,
      'llm/+page.server.ts': `export const actions = { save: async () => ({}), clear: async () => ({}) }`,
    }
    expect(entryPointsOf('llm/byok/[provider]/+page.server.ts', reader(files))).toEqual([
      '?/clear',
      '?/save',
    ])
  })

  it('follows actions imported from $lib (renamed or not) to their object literal', () => {
    const files = {
      'routes/s/+page.server.ts': `
        import type { Actions } from './$types'
        import { llmActions as shared } from '$lib/server/settings/page.server'
        export const actions: Actions = shared
      `,
      'lib/server/settings/page.server.ts': `
        export const llmActions: Actions = { saveConfig: async () => ({}), setActive: async () => ({}) }
      `,
    }
    expect(entryPointsOf('routes/s/+page.server.ts', reader(files))).toEqual([
      '?/saveConfig',
      '?/setActive',
    ])
  })

  it('fails loud on an import from a package (it cannot be read statically)', () => {
    const files = {
      'routes/s/+page.server.ts': `import { a } from 'some-package'\nexport const actions = a`,
    }
    expect(() => entryPointsOf('routes/s/+page.server.ts', reader(files))).toThrow(/cannot follow/)
  })

  it('fails loud on actions it cannot list statically (a spread, a call)', () => {
    const spread = { 'p/+page.server.ts': `export const actions = { ...shared, own: async () => ({}) }` }
    const call = { 'p/+page.server.ts': `export const actions = makeActions()` }
    expect(() => entryPointsOf('p/+page.server.ts', reader(spread))).toThrow(/statically/)
    expect(() => entryPointsOf('p/+page.server.ts', reader(call))).toThrow(/statically/)
  })

  it('has no entry points for a page without actions', () => {
    const files = { 'p/+page.server.ts': `export const load = async () => ({ a: 1 })` }
    expect(entryPointsOf('p/+page.server.ts', reader(files))).toEqual([])
  })
})
