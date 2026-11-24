import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

/**
 * `eem/1`, the runtime protocol between the kernel and a module
 * (plan/phase-upgrades-u2.md §4): JSON-RPC 2.0, one message per NDJSON line,
 * over one Unix socket connection the module opens. Imported by ee and by
 * modules' vendored SDK, so only `zod` and `node:*`.
 */

export const MODULE_PROTOCOL = 'eem/1'
/** One line (one message), UTF-8, newline excluded. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024
export const HEARTBEAT_MS = 10_000
/** No `ready` this long after connecting → failing (§4.6 b). */
export const READY_TIMEOUT_MS = 60_000
/** No heartbeat this long → failing (§4.6 c). */
export const HEARTBEAT_MISS_MS = 30_000
/** After `shutdown`, the module has this long to exit. */
export const SHUTDOWN_GRACE_MS = 10_000
/** The SDK's reconnect: every second, for two minutes, then exit non-zero. */
export const RECONNECT_INTERVAL_MS = 1_000
export const RECONNECT_GIVE_UP_MS = 120_000
export const MAX_DEADLINE_MS = 120_000
/** One data file: JSON or a string, at most 1 MiB; at most 200 MiB per module. */
export const DATA_FILE_MAX_BYTES = 1024 * 1024
export const DATA_MODULE_MAX_BYTES = 200 * 1024 * 1024

/** The socket path inside the module's unit (ee bind-mounts the directory). */
export const MODULE_SOCKET_DIR = '/run/ee-module'
export const MODULE_SOCKET_PATH = `${MODULE_SOCKET_DIR}/kernel.sock`

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The error codes U2 adds (§4.6). Registry codes (permission_denied, …) pass through unchanged. */
export const MODULE_ERROR_CODES = [
  'module_use_undeclared',
  'module_not_running',
  'module_timeout',
  'module_protocol',
  'module_no_person',
  'module_unreceipted',
  'module_sharing_not_accepted',
  'module_needs_admin_click',
  'hub_unavailable',
  'data_not_found',
  'data_conflict',
  'data_quota',
] as const
export type ModuleErrorCode = (typeof MODULE_ERROR_CODES)[number]

/** Every eem/1 error is JSON-RPC -32000 with `data: {code, message, detail}`. */
export const EEM_ERROR = -32000

export const errorDataSchema = z.strictObject({
  /** A module error code or a registry error code (snake_case). */
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().min(1).max(2000),
  detail: z.unknown(),
})
export type EemErrorData = z.output<typeof errorDataSchema>

export const jsonRpcErrorSchema = z.strictObject({
  code: z.literal(EEM_ERROR),
  message: z.string().min(1).max(2000),
  data: errorDataSchema,
})
export type EemError = z.output<typeof jsonRpcErrorSchema>

/** The wire error for `code`; `detail` defaults to null (never absent). */
export function eemError(code: string, message: string, detail: unknown = null): EemError {
  return jsonRpcErrorSchema.parse({ code: EEM_ERROR, message, data: { code, message, detail } })
}

// ─── Values ──────────────────────────────────────────────────────────────────

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const CORE_TOOL = /^[a-z][a-z0-9_-]*\.[a-z][a-zA-Z0-9_-]*$/
const LOCAL_NAME = /^[a-z][a-z0-9_]{0,40}$/
const ID = z.string().min(1).max(200)

/** Any JSON value (what a tool takes or returns, an event payload, a data file). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().refine(Number.isFinite, { message: 'a finite number' }),
    z.string(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
)

/** `EE_MODULE_TOKEN`: 32 random bytes as 64 lowercase hex, new on every deploy. */
export const moduleTokenSchema = z.string().regex(HEX64, '64 lowercase hex')
export const newModuleToken = (): string => randomBytes(32).toString('hex')
/** What the kernel stores as the module principal's apiKeyHash: sha256(token), hex. */
export const moduleTokenHash = (token: string): string =>
  createHash('sha256').update(moduleTokenSchema.parse(token), 'utf8').digest('hex')

/** A data path: relative to `extensions/<id>/`, no empty, `.` or `..` segments. */
export const dataPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'),
    { message: 'a relative path without empty, "." or ".." segments' },
  )
const etag = z.string().min(1).max(200)

export const principalSchema = z.strictObject({
  id: ID,
  kind: z.enum(['human', 'coworker', 'agent', 'service']),
  roles: z.array(z.string().min(1).max(64)),
})

export const deliveredEventSchema = z.strictObject({
  id: ID,
  ts: z.iso.datetime(),
  type: z.string().min(1).max(200),
  principalId: ID.optional(),
  source: z.string().min(1).max(400).optional(),
  payload: jsonSchema,
})

const empty = z.strictObject({})

// ─── Methods ─────────────────────────────────────────────────────────────────

/** Module → kernel (§4.2, §4.3). */
export const MODULE_TO_KERNEL = {
  hello: {
    params: z.strictObject({
      protocol: z.literal(MODULE_PROTOCOL),
      moduleId: z.string().min(2).max(24).regex(MODULE_ID),
      commit: z.string().regex(HEX40),
      token: moduleTokenSchema,
    }),
    result: z.strictObject({
      coreApi: z.string().regex(/^\d+\.\d+\.\d+$/),
      heartbeatMs: z.number().int().positive(),
      grants: z.strictObject({
        background: z.boolean(),
        secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
      }),
    }),
  },
  ready: { params: empty, result: empty },
  'tools.call': {
    params: z.strictObject({
      name: z.string().regex(CORE_TOOL),
      input: jsonSchema,
      callId: ID.optional(),
    }),
    result: jsonSchema,
  },
  'events.emit': {
    params: z.strictObject({ name: z.string().regex(LOCAL_NAME), payload: jsonSchema }),
    result: z.strictObject({ id: ID }),
  },
  'data.get': {
    params: z.strictObject({ path: dataPathSchema }),
    result: z.strictObject({ content: jsonSchema, etag }),
  },
  'data.put': {
    params: z.strictObject({ path: dataPathSchema, content: jsonSchema, ifMatch: etag.optional() }),
    result: z.strictObject({ etag }),
  },
  'data.list': {
    params: z.strictObject({
      prefix: z.string().max(512).optional(),
      cursor: z.string().min(1).max(512).optional(),
    }),
    result: z.strictObject({
      items: z.array(
        z.strictObject({ path: dataPathSchema, etag, size: z.number().int().nonnegative() }),
      ),
      cursor: z.string().min(1).max(512).nullable(),
    }),
  },
  'data.delete': {
    params: z.strictObject({ path: dataPathSchema, ifMatch: etag.optional() }),
    result: empty,
  },
  heartbeat: { params: empty, result: empty },
} as const

/** Kernel → module (§4.4). */
export const KERNEL_TO_MODULE = {
  'tool.invoke': {
    params: z.strictObject({
      callId: ID,
      tool: z.string().regex(LOCAL_NAME),
      input: jsonSchema,
      principal: principalSchema,
      /** Milliseconds the module has to answer. */
      deadlineMs: z.number().int().positive().max(MAX_DEADLINE_MS),
    }),
    result: jsonSchema,
  },
  'event.deliver': {
    params: z.strictObject({ deliveryId: ID, event: deliveredEventSchema }),
    result: empty,
  },
  shutdown: {
    params: z.strictObject({ reason: z.string().min(1).max(300) }),
    result: empty,
  },
} as const

export type ModuleToKernelMethod = keyof typeof MODULE_TO_KERNEL
export type KernelToModuleMethod = keyof typeof KERNEL_TO_MODULE
export type ParamsOf<T extends Record<string, { params: z.ZodType }>, M extends keyof T> = z.output<
  T[M]['params']
>
export type ResultOf<T extends Record<string, { result: z.ZodType }>, M extends keyof T> = z.output<
  T[M]['result']
>

// ─── Envelopes ───────────────────────────────────────────────────────────────

const requestId = z.union([z.number().int().nonnegative(), z.string().min(1).max(200)])

export const requestEnvelopeSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: requestId,
  method: z.string().min(1).max(100),
  params: z.unknown(),
})
export const resultEnvelopeSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: requestId,
  result: z.unknown(),
})
export const errorEnvelopeSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  /** null only when the request's id could not be read. */
  id: requestId.nullable(),
  error: jsonRpcErrorSchema,
})

export type EemRequest = { jsonrpc: '2.0'; id: number | string; method: string; params: unknown }
export type EemResult = { jsonrpc: '2.0'; id: number | string; result: unknown }
export type EemErrorResponse = { jsonrpc: '2.0'; id: number | string | null; error: EemError }
export type EemMessage = EemRequest | EemResult | EemErrorResponse

export const request = (id: number | string, method: string, params: unknown): EemRequest => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
})
export const result = (id: number | string, value: unknown): EemResult => ({
  jsonrpc: '2.0',
  id,
  result: value,
})
export const errorResponse = (id: number | string | null, error: EemError): EemErrorResponse => ({
  jsonrpc: '2.0',
  id,
  error,
})

export class EemProtocolError extends Error {
  readonly code = 'module_protocol'
  constructor(message: string) {
    super(message)
    this.name = 'EemProtocolError'
  }
}

/** Classifies a decoded line as a request, a result or an error; anything else is a protocol violation. */
export function parseMessage(value: unknown): EemMessage {
  if (value && typeof value === 'object') {
    if ('method' in value) {
      const r = requestEnvelopeSchema.safeParse(value)
      if (r.success) return r.data as EemRequest
    } else if ('error' in value) {
      const r = errorEnvelopeSchema.safeParse(value)
      if (r.success) return r.data
    } else if ('result' in value) {
      const r = resultEnvelopeSchema.safeParse(value)
      if (r.success) return r.data as EemResult
    }
  }
  throw new EemProtocolError('not a JSON-RPC 2.0 request, result or error')
}

type Table = Record<string, { params: z.ZodType; result: z.ZodType }>

function lookup(table: Table, method: string, side: string) {
  if (!Object.hasOwn(table, method)) throw new EemProtocolError(`${side} has no method "${method}"`)
  return table[method]!
}

/** Validates the params of a request the kernel received from a module. */
export function parseModuleRequest<M extends ModuleToKernelMethod>(
  method: M,
  params: unknown,
): ParamsOf<typeof MODULE_TO_KERNEL, M>
export function parseModuleRequest(method: string, params: unknown): unknown
export function parseModuleRequest(method: string, params: unknown): unknown {
  const r = lookup(MODULE_TO_KERNEL, method, 'the kernel').params.safeParse(params)
  if (!r.success) throw new EemProtocolError(`${method} params: ${r.error.issues[0]!.message}`)
  return r.data
}

/** Validates the params of a request a module received from the kernel. */
export function parseKernelRequest<M extends KernelToModuleMethod>(
  method: M,
  params: unknown,
): ParamsOf<typeof KERNEL_TO_MODULE, M>
export function parseKernelRequest(method: string, params: unknown): unknown
export function parseKernelRequest(method: string, params: unknown): unknown {
  const r = lookup(KERNEL_TO_MODULE, method, 'a module').params.safeParse(params)
  if (!r.success) throw new EemProtocolError(`${method} params: ${r.error.issues[0]!.message}`)
  return r.data
}

/** Validates the result of a module → kernel call (on the module side). */
export function parseModuleResult<M extends ModuleToKernelMethod>(
  method: M,
  value: unknown,
): ResultOf<typeof MODULE_TO_KERNEL, M> {
  const r = MODULE_TO_KERNEL[method].result.safeParse(value)
  if (!r.success) throw new EemProtocolError(`${method} result: ${r.error.issues[0]!.message}`)
  return r.data as ResultOf<typeof MODULE_TO_KERNEL, M>
}

/** Validates the result of a kernel → module call (on the kernel side). */
export function parseKernelResult<M extends KernelToModuleMethod>(
  method: M,
  value: unknown,
): ResultOf<typeof KERNEL_TO_MODULE, M> {
  const r = KERNEL_TO_MODULE[method].result.safeParse(value)
  if (!r.success) throw new EemProtocolError(`${method} result: ${r.error.issues[0]!.message}`)
  return r.data as ResultOf<typeof KERNEL_TO_MODULE, M>
}

// ─── Framing ─────────────────────────────────────────────────────────────────

export class FrameTooLargeError extends EemProtocolError {
  constructor(bytes: number) {
    super(`a message line is ${bytes} bytes or more, at most ${MAX_FRAME_BYTES}`)
    this.name = 'FrameTooLargeError'
  }
}

/** One message as one NDJSON line (`\n`-terminated). Refuses a line over the cap. */
export function encodeFrame(message: EemMessage): Buffer {
  const line = Buffer.from(JSON.stringify(message), 'utf8')
  if (line.byteLength > MAX_FRAME_BYTES) throw new FrameTooLargeError(line.byteLength)
  return Buffer.concat([line, Buffer.from('\n')])
}

/**
 * Splits a byte stream into messages. Lines may arrive in any chunking
 * (including mid-UTF-8 character). A line over the cap, invalid UTF-8, invalid
 * JSON or a non-JSON-RPC message throws `EemProtocolError`; the connection is
 * then to be closed.
 */
export class FrameDecoder {
  private parts: Buffer[] = []
  private size = 0
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })

  push(chunk: Uint8Array): EemMessage[] {
    const out: EemMessage[] = []
    let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a)) {
      const tail = buf.subarray(0, nl)
      if (this.size + tail.byteLength > MAX_FRAME_BYTES)
        throw new FrameTooLargeError(this.size + tail.byteLength)
      const line = this.parts.length ? Buffer.concat([...this.parts, tail]) : tail
      this.parts = []
      this.size = 0
      buf = buf.subarray(nl + 1)
      if (line.byteLength === 0) throw new EemProtocolError('an empty message line')
      out.push(this.decode(line))
    }
    if (buf.byteLength) {
      if (this.size + buf.byteLength > MAX_FRAME_BYTES)
        throw new FrameTooLargeError(this.size + buf.byteLength)
      this.parts.push(Buffer.from(buf))
      this.size += buf.byteLength
    }
    return out
  }

  /** Bytes of an unfinished line still waiting for its newline. */
  get pending(): number {
    return this.size
  }

  private decode(line: Buffer): EemMessage {
    let text: string
    try {
      text = this.utf8.decode(line)
    } catch {
      throw new EemProtocolError('a message line is not valid UTF-8')
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new EemProtocolError('a message line is not JSON')
    }
    return parseMessage(value)
  }
}
