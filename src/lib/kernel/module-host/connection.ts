import type { Socket } from 'node:net'
import {
  eemError,
  EemProtocolError,
  encodeFrame,
  errorResponse,
  FrameDecoder,
  request,
  result,
  type EemError,
  type EemMessage,
  type EemRequest,
} from '../../../../contracts/module-protocol'

/**
 * One eem/1 connection (plan/phase-upgrades-u2.md §4.1): NDJSON JSON-RPC 2.0
 * over a Unix socket, used in both directions. Outgoing requests wait for
 * their answer; incoming requests go to `onRequest`, whose value is the
 * result and whose thrown EemCallError (or any error) is the error answer.
 * A framing or envelope violation ends the connection.
 */

/** An error answer: the wire `{code, message, detail}` of `data`. */
export class EemCallError extends Error {
  constructor(readonly error: EemError) {
    super(error.data.message)
    this.name = 'EemCallError'
  }
  get code(): string {
    return this.error.data.code
  }
  get detail(): unknown {
    return this.error.data.detail
  }
}

export type IncomingRequest = { id: number | string; method: string; params: unknown }

export type ConnectionHandlers = {
  onRequest(request: IncomingRequest): Promise<unknown>
  /** A framing or envelope violation (the connection is then closed). */
  onViolation(error: EemProtocolError): void
  onClose(): void
}

export class EemConnection {
  private readonly decoder = new FrameDecoder()
  private nextId = 1
  private readonly waiting = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> | null }
  >()
  private closed = false

  constructor(
    private readonly socket: Socket,
    private readonly handlers: ConnectionHandlers,
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('error', () => this.close())
    socket.on('close', () => this.close())
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Sends a request and waits for its answer (an EemCallError on an error answer). */
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('the module connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              this.waiting.delete(id)
              reject(new CallTimeoutError(method, timeoutMs))
            }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      this.write(request(id, method, params))
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [, w] of this.waiting) {
      if (w.timer) clearTimeout(w.timer)
      w.reject(new Error('the module connection closed'))
    }
    this.waiting.clear()
    this.socket.destroy()
    this.handlers.onClose()
  }

  private write(message: EemMessage): void {
    if (this.closed) return
    this.socket.write(encodeFrame(message))
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    let messages: EemMessage[]
    try {
      messages = this.decoder.push(chunk)
    } catch (err) {
      const violation = err instanceof EemProtocolError ? err : new EemProtocolError(String(err))
      this.write(errorResponse(null, eemError('module_protocol', violation.message)))
      this.handlers.onViolation(violation)
      this.close()
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  private dispatch(message: EemMessage): void {
    if ('method' in message) {
      void this.answer(message)
      return
    }
    if (message.id === null) return // an error the module could not attribute
    const w = this.waiting.get(message.id)
    if (!w) return // an answer after its timeout
    this.waiting.delete(message.id)
    if (w.timer) clearTimeout(w.timer)
    if ('error' in message) w.reject(new EemCallError(message.error))
    else w.resolve(message.result)
  }

  private async answer(req: EemRequest): Promise<void> {
    try {
      const value = await this.handlers.onRequest({ id: req.id, method: req.method, params: req.params })
      this.write(result(req.id, value ?? {}))
    } catch (err) {
      this.write(errorResponse(req.id, toEemError(err)))
    }
  }
}

export class CallTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} got no answer within ${timeoutMs} ms`)
    this.name = 'CallTimeoutError'
  }
}

/** Any error as the wire error: a kernel or eem code with its message and structured detail. */
export function toEemError(err: unknown): EemError {
  if (err instanceof EemCallError) return err.error
  const coded = err as { code?: unknown; message?: unknown; details?: unknown } | null
  const code =
    coded && typeof coded.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(coded.code)
      ? coded.code
      : 'internal_error'
  const message =
    coded && typeof coded.message === 'string' && coded.message.length > 0
      ? coded.message.slice(0, 2000)
      : 'the kernel failed'
  const detail = coded && coded.details !== undefined ? jsonSafe(coded.details) : null
  return eemError(code, message, detail)
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return null
  }
}
