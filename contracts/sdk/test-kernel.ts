/**
 * An in-memory kernel for a module's own tests (plan/phase-upgrades-u2.md
 * §4.7): it runs the module's tools and event handlers the way the real
 * kernel would and enforces the same `uses:` rules — a core tool outside
 * `uses.tools` is `module_use_undeclared`, a background call without
 * `permissions.background` is `module_no_person`, an event outside
 * `provides.events` is refused — and every `uses.tools` name must be in the
 * core-api lock (the vendored `core-tools.json`). Core tools answer with the
 * fakes the test gives; `data.*` is a map.
 *
 * Vendored into every module with module-runtime.ts: `node:*` only, erasable
 * TypeScript only.
 */
import {
  moduleError,
  type DeliveredEvent,
  type Json,
  type ModuleContext,
  type ModuleDataApi,
  type ModuleDefinition,
  type Principal,
} from './module-runtime.ts'
import { createHash } from 'node:crypto'

export type CoreFake = (input: Json, principal: Principal | null) => Json | Promise<Json>

export type TestKernelOptions = {
  uses: { tools: readonly string[]; events?: readonly string[] }
  provides?: { events?: readonly string[] }
  permissions?: { background?: boolean }
  /** The core tool names of the box's core-api lock (`vendor/eigen-sdk/core-tools.json`). */
  lockTools: readonly string[]
  /** Fake answers of the core tools the module uses. */
  core?: Record<string, CoreFake>
}

export type TestKernel = {
  /** Runs one of the module's tools as `principal` (a member by default), like `tool.invoke`. */
  invoke(tool: string, input: Json, principal?: Principal): Promise<Json>
  /** Delivers an event (its type must be in `uses.events`), like `event.deliver`. */
  deliver(event: Omit<DeliveredEvent, 'id' | 'ts'> & Partial<Pick<DeliveredEvent, 'id' | 'ts'>>): Promise<void>
  /** The module's data files. */
  readonly data: Map<string, Json>
  /** Every `events.emit`. */
  readonly emitted: { name: string; payload: Json }[]
  /** Every core call, with who it ran as (null = in the background). */
  readonly calls: { name: string; input: Json; principal: Principal | null }[]
}

const etagOf = (content: Json): string => createHash('sha256').update(`${JSON.stringify(content)}\n`).digest('hex')

export const TEST_PERSON: Principal = { id: 'test-person', kind: 'human', roles: ['member'] }

export function testKernel(definition: ModuleDefinition, options: TestKernelOptions): TestKernel {
  const lock = new Set(options.lockTools)
  for (const name of options.uses.tools) {
    if (!lock.has(name)) throw new Error(`uses.tools names ${name}, which is not in the core-api lock`)
  }
  const data = new Map<string, Json>()
  const emitted: { name: string; payload: Json }[] = []
  const calls: { name: string; input: Json; principal: Principal | null }[] = []
  const usesTools = new Set(options.uses.tools)
  const usesEvents = new Set(options.uses.events ?? [])
  const providesEvents = new Set(options.provides?.events ?? [])

  const dataApi: ModuleDataApi = {
    async get(path) {
      if (!data.has(path)) throw moduleError('data_not_found', `no data file ${path}`, { path })
      const content = data.get(path)!
      return { content, etag: etagOf(content) }
    },
    async put(path, content, ifMatch) {
      if (ifMatch !== undefined && (!data.has(path) || etagOf(data.get(path)!) !== ifMatch)) {
        throw moduleError('data_conflict', `data file ${path} changed since etag ${ifMatch}`, { path })
      }
      data.set(path, structuredClone(content))
      return { etag: etagOf(content) }
    },
    async list(prefix) {
      const items = [...data.entries()]
        .filter(([p]) => prefix === undefined || p.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, content]) => ({ path, etag: etagOf(content), size: Buffer.byteLength(`${JSON.stringify(content)}\n`) }))
      return { items, cursor: null }
    },
    async delete(path, ifMatch) {
      if (ifMatch !== undefined && (!data.has(path) || etagOf(data.get(path)!) !== ifMatch)) {
        throw moduleError('data_conflict', `data file ${path} changed since etag ${ifMatch}`, { path })
      }
      data.delete(path)
    },
  }

  const context = (principal: Principal | null): ModuleContext => ({
    principal,
    async call(name, input) {
      if (!usesTools.has(name)) throw moduleError('module_use_undeclared', `${name} is not declared in uses.tools`, { tool: name })
      if (principal === null && options.permissions?.background !== true) {
        throw moduleError('module_no_person', 'a call without a person needs permissions.background')
      }
      const fake = options.core?.[name]
      if (!fake) throw new Error(`the test kernel has no fake answer for ${name}`)
      calls.push({ name, input, principal })
      return fake(input, principal)
    },
    async emit(name, payload) {
      if (!providesEvents.has(name)) throw moduleError('module_use_undeclared', `event ${name} is not declared in provides.events`)
      emitted.push({ name, payload })
      return { id: `event-${emitted.length}` }
    },
    data: dataApi,
  })

  let n = 0
  return {
    data,
    emitted,
    calls,
    async invoke(tool, input, principal = TEST_PERSON) {
      const handler = definition.tools[tool]
      if (!handler) throw moduleError('invalid_input', `the module has no tool "${tool}"`)
      return handler(structuredClone(input), context(principal))
    },
    async deliver(event) {
      if (!usesEvents.has(event.type)) throw new Error(`event ${event.type} is not in uses.events: the kernel never delivers it`)
      const on = definition.events?.[event.type]
      n += 1
      if (on) {
        await on(
          { ...event, id: event.id ?? `delivered-${n}`, ts: event.ts ?? new Date().toISOString() },
          context(null),
        )
      }
    },
  }
}
