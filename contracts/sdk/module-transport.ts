/**
 * The generated core-api SDK's transport over a module's eem/1 session
 * (plan/phase-upgrades-u2.md §4.7): `createCoreApiClient(moduleTransport(ctx))`
 * gives a module the typed client of every core tool, and each call travels
 * as `tools.call` — as the person the tool call runs as, or in the background.
 * The SDK's types stay those of `core-api.ts`; only the wire differs.
 *
 * Vendored into every module with module-runtime.ts: `node:*` only, erasable
 * TypeScript only.
 */
import type { Json, ModuleContext } from './module-runtime.ts'

/** Structurally `CoreApiTransport` of `./transport.ts`. */
export type ModuleCoreApiTransport = {
  callTool(name: string, input: unknown): Promise<unknown>
}

export function moduleTransport(ctx: Pick<ModuleContext, 'call'>): ModuleCoreApiTransport {
  return {
    callTool: (name, input) => ctx.call(name, (input ?? {}) as Json),
  }
}
