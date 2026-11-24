/**
 * The module side of `eem/1` (plan/phase-upgrades-u2.md §4, §4.7): what a
 * company module imports to talk to its kernel. `defineModule` takes the
 * module's tools and event handlers; `run()` connects to `EE_MODULE_SOCKET`,
 * says hello with `EE_MODULE_ID`, `EE_MODULE_COMMIT` and `EE_MODULE_TOKEN`,
 * sends `ready`, keeps the heartbeat, answers `tool.invoke` and
 * `event.deliver`, and reconnects every second for two minutes before it
 * exits non-zero.
 *
 * Vendored into every module (`<id>/vendor/eigen-sdk/`, D9), so it imports
 * only `node:*` and runs under Node 22's type stripping: erasable TypeScript
 * only (no enums, namespaces or parameter properties).
 */
import { connect, type Socket } from 'node:net'

export const PROTOCOL = 'eem/1'
export const MAX_LINE_BYTES = 4 * 1024 * 1024
export const RECONNECT_EVERY_MS = 1_000
export const RECONNECT_GIVE_UP_MS = 120_000
export const EEM_ERROR = -32000

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Principal = { id: string; kind: 'human' | 'coworker' | 'agent' | 'service'; roles: string[] }

export type DeliveredEvent = {
  id: string
  ts: string
  type: string
  principalId?: string
  source?: string
  payload: Json
}

/** `data.*`: the module's only persistence, files under `extensions/<id>/` in the company data repo. */
export type ModuleDataApi = {
  get(path: string): Promise<{ content: Json; etag: string }>
  put(path: string, content: Json, ifMatch?: string): Promise<{ etag: string }>
  list(prefix?: string, cursor?: string): Promise<{ items: { path: string; etag: string; size: number }[]; cursor: string | null }>
  delete(path: string, ifMatch?: string): Promise<void>
}

/** What a tool or event handler is given. */
export type ModuleContext = {
  /** The person the call runs as (a tool call's invoker), or null for an event. */
  principal: Principal | null
  /** A core tool from `uses.tools`: as the invoking person in a tool call; in the background otherwise (needs permissions.background). */
  call(name: string, input: Json): Promise<Json>
  /** Emits one of `provides.events`. */
  emit(name: string, payload: Json): Promise<{ id: string }>
  data: ModuleDataApi
}

export type ToolHandler = (input: Json, ctx: ModuleContext) => Json | Promise<Json>
export type EventHandler = (event: DeliveredEvent, ctx: ModuleContext) => void | Promise<void>

export type ModuleDefinition = {
  tools: Record<string, ToolHandler>
  /** By core event type (`contacts.created`); idempotent on `event.id` (delivery is at-least-once). */
  events?: Record<string, EventHandler>
}

/** An error answer from the kernel: `code` is a kernel or eem error code (`module_use_undeclared`, …). */
export class ModuleCallError extends Error {
  readonly code: string
  readonly detail: unknown
  constructor(code: string, message: string, detail: unknown) {
    super(message)
    this.name = 'ModuleCallError'
    this.code = code
    this.detail = detail
  }
}

/** Throw from a tool to answer with your own code (`not_found`, `invalid_input`, …). */
export function moduleError(code: string, message: string, detail: unknown = null): ModuleCallError {
  return new ModuleCallError(code, message, detail)
}

type Wire = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: { code: string; message: string; detail: unknown } } }

/** One live connection to the kernel. */
export class ModuleSession {
  private readonly socket: Socket
  private nextId = 1
  private readonly waiting = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private buffer = ''
  private handler: (method: string, params: unknown) => Promise<unknown>
  closed = false

  constructor(socket: Socket, handler: (method: string, params: unknown) => Promise<unknown>) {
    this.socket = socket
    this.handler = handler
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.receive(chunk))
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('the kernel connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const w of this.waiting.values()) w.reject(new Error('the kernel connection closed'))
    this.waiting.clear()
    this.socket.destroy()
  }

  private write(message: Wire): void {
    const line = JSON.stringify(message)
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`a message is over ${MAX_LINE_BYTES} bytes`)
    this.socket.write(`${line}\n`)
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES + 1) {
      this.close()
      return
    }
    for (let nl = this.buffer.indexOf('\n'); nl !== -1; nl = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      let message: Wire
      try {
        message = JSON.parse(line) as Wire
      } catch {
        this.close()
        return
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Wire): void {
    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
      const id = message.id
      this.handler(message.method, message.params).then(
        (result) => this.write({ jsonrpc: '2.0', id, result: result ?? {} }),
        (err: unknown) => {
          const coded = err instanceof ModuleCallError ? err : null
          const code = coded ? coded.code : 'module_error'
          const text = err instanceof Error && err.message ? err.message : 'the module failed'
          this.write({ jsonrpc: '2.0', id, error: { code: EEM_ERROR, message: text, data: { code, message: text, detail: coded ? coded.detail : null } } })
        },
      )
      return
    }
    if (message.id === undefined || message.id === null) return
    const w = this.waiting.get(message.id)
    if (!w) return
    this.waiting.delete(message.id)
    if (message.error) {
      const data = message.error.data
      w.reject(new ModuleCallError(data ? data.code : 'module_protocol', data ? data.message : message.error.message, data ? data.detail : null))
    } else w.resolve(message.result)
  }
}

export type RunOptions = {
  /** Defaults to process.env (EE_MODULE_SOCKET, EE_MODULE_ID, EE_MODULE_COMMIT, EE_MODULE_TOKEN). */
  env?: Record<string, string | undefined>
  /** Called when the kernel asks the module to shut down; default: exit 0. */
  onShutdown?: (reason: string) => void
  /** Called after two minutes without a kernel; default: exit 1. */
  onGiveUp?: () => void
}

export type RunningModule = {
  /** The current session (null while reconnecting). */
  session(): ModuleSession | null
  /** Waits until the module said `ready` on a session. */
  ready(): Promise<void>
  stop(): void
}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]
  if (!v) throw new Error(`${name} is not set: a module runs under ee, which sets it`)
  return v
}

function dataApi(session: () => ModuleSession): ModuleDataApi {
  return {
    get: async (path) => (await session().request('data.get', { path })) as { content: Json; etag: string },
    put: async (path, content, ifMatch) =>
      (await session().request('data.put', ifMatch === undefined ? { path, content } : { path, content, ifMatch })) as { etag: string },
    list: async (prefix, cursor) =>
      (await session().request('data.list', {
        ...(prefix === undefined ? {} : { prefix }),
        ...(cursor === undefined ? {} : { cursor }),
      })) as { items: { path: string; etag: string; size: number }[]; cursor: string | null },
    delete: async (path, ifMatch) => {
      await session().request('data.delete', ifMatch === undefined ? { path } : { path, ifMatch })
    },
  }
}

/** The context a handler gets: `callId` ties core calls to the invoking person. */
export function moduleContext(session: () => ModuleSession, principal: Principal | null, callId: string | null): ModuleContext {
  return {
    principal,
    call: async (name, input) =>
      (await session().request('tools.call', callId === null ? { name, input } : { name, input, callId })) as Json,
    emit: async (name, payload) => (await session().request('events.emit', { name, payload })) as { id: string },
    data: dataApi(session),
  }
}

export function defineModule(definition: ModuleDefinition): { definition: ModuleDefinition; run(options?: RunOptions): RunningModule } {
  return { definition, run: (options = {}) => runModule(definition, options) }
}

function runModule(definition: ModuleDefinition, options: RunOptions): RunningModule {
  const env = options.env ?? process.env
  const socketPath = required(env, 'EE_MODULE_SOCKET')
  const hello = {
    protocol: PROTOCOL,
    moduleId: required(env, 'EE_MODULE_ID'),
    commit: required(env, 'EE_MODULE_COMMIT'),
    token: required(env, 'EE_MODULE_TOKEN'),
  }
  let current: ModuleSession | null = null
  let stopped = false
  let firstFailure: number | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let readyWaiters: (() => void)[] = []
  let isReady = false
  const live = (): ModuleSession => {
    if (!current) throw new Error('the module is not connected to its kernel right now')
    return current
  }

  const handle = async (method: string, params: unknown): Promise<unknown> => {
    const p = params as Record<string, unknown>
    if (method === 'tool.invoke') {
      const tool = definition.tools[String(p.tool)]
      if (!tool) throw moduleError('invalid_input', `this module has no tool "${String(p.tool)}"`)
      return tool(p.input as Json, moduleContext(live, p.principal as Principal, String(p.callId)))
    }
    if (method === 'event.deliver') {
      const event = p.event as DeliveredEvent
      const on = definition.events?.[event.type]
      if (on) await on(event, moduleContext(live, null, null))
      return {}
    }
    if (method === 'shutdown') {
      setImmediate(() => (options.onShutdown ?? (() => process.exit(0)))(String(p.reason)))
      return {}
    }
    throw moduleError('module_protocol', `a module does not answer "${method}"`)
  }

  const open = (): void => {
    if (stopped) return
    const socket = connect(socketPath)
    const session = new ModuleSession(socket, handle)
    socket.on('connect', () => {
      void (async () => {
        try {
          const welcome = (await session.request('hello', hello)) as { heartbeatMs: number }
          await session.request('ready', {})
          firstFailure = null
          current = session
          isReady = true
          for (const w of readyWaiters) w()
          readyWaiters = []
          heartbeat = setInterval(() => {
            session.request('heartbeat', {}).catch(() => session.close())
          }, welcome.heartbeatMs)
        } catch {
          session.close()
          socket.destroy()
        }
      })()
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      session.close()
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      if (current === session) current = null
      isReady = false
      if (stopped) return
      firstFailure ??= Date.now()
      if (Date.now() - firstFailure > RECONNECT_GIVE_UP_MS) {
        ;(options.onGiveUp ?? (() => process.exit(1)))()
        return
      }
      setTimeout(open, RECONNECT_EVERY_MS)
    })
  }
  open()

  return {
    session: () => current,
    ready: () => (isReady ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve))),
    stop: () => {
      stopped = true
      if (heartbeat) clearInterval(heartbeat)
      current?.close()
    },
  }
}
