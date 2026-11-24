import { describe, expect, it } from 'vitest'
import {
  eemError,
  EemProtocolError,
  encodeFrame,
  errorResponse,
  FrameDecoder,
  FrameTooLargeError,
  KERNEL_TO_MODULE,
  MAX_FRAME_BYTES,
  MODULE_ERROR_CODES,
  MODULE_TO_KERNEL,
  moduleTokenHash,
  newModuleToken,
  parseKernelRequest,
  parseKernelResult,
  parseMessage,
  parseModuleRequest,
  parseModuleResult,
  request,
  result,
  type EemMessage,
} from './module-protocol'

const roundTrip = (msg: EemMessage): EemMessage[] => new FrameDecoder().push(encodeFrame(msg))

const moduleCalls: { [M in keyof typeof MODULE_TO_KERNEL]: [unknown, unknown] } = {
  hello: [
    { protocol: 'eem/1', moduleId: 'hello', commit: 'c0'.repeat(20), token: 'ab'.repeat(32) },
    {
      coreApi: '1.0.0',
      heartbeatMs: 10_000,
      grants: { background: false, secrets: ['STRIPE_API_KEY'] },
    },
  ],
  ready: [{}, {}],
  'tools.call': [{ name: 'members.list', input: {}, callId: 'call-1' }, { members: [] }],
  'events.emit': [{ name: 'sent', payload: { number: 'INV-1' } }, { id: 'evt-1' }],
  'data.get': [{ path: 'invoices/1.json' }, { content: { n: 1 }, etag: 'e1' }],
  'data.put': [{ path: 'invoices/1.json', content: 'text', ifMatch: 'e1' }, { etag: 'e2' }],
  'data.list': [
    { prefix: 'invoices/' },
    { items: [{ path: 'invoices/1.json', etag: 'e2', size: 4 }], cursor: null },
  ],
  'data.delete': [{ path: 'invoices/1.json' }, {}],
  heartbeat: [{}, {}],
}
const kernelCalls: { [M in keyof typeof KERNEL_TO_MODULE]: [unknown, unknown] } = {
  'tool.invoke': [
    {
      callId: 'call-1',
      tool: 'greet',
      input: { name: 'Ada' },
      principal: { id: 'u1', kind: 'human', roles: ['member'] },
      deadlineMs: 5000,
    },
    { greeting: 'Hello, Ada!' },
  ],
  'event.deliver': [
    {
      deliveryId: 'd1',
      event: {
        id: 'evt-1',
        ts: '2026-11-24T12:00:00.000Z',
        type: 'contacts.created',
        payload: { id: 'c1' },
      },
    },
    {},
  ],
  shutdown: [{ reason: 'deploying a new commit' }, {}],
}

describe('eem/1 messages: module → kernel', () => {
  it.each(Object.entries(moduleCalls))(
    '%s round-trips request and result',
    (method, [params, res]) => {
      const [req] = roundTrip(request(7, method, params))
      expect(req).toEqual(request(7, method, params))
      expect(parseModuleRequest(method, (req as { params: unknown }).params)).toEqual(params)
      const [ans] = roundTrip(result(7, res))
      expect(
        parseModuleResult(
          method as keyof typeof MODULE_TO_KERNEL,
          (ans as { result: unknown }).result,
        ),
      ).toEqual(res)
    },
  )

  it('refuses unknown methods, wrong protocol, extra params and bad paths', () => {
    expect(() => parseModuleRequest('exec', {})).toThrow(EemProtocolError)
    expect(() =>
      parseModuleRequest('hello', { ...moduleCalls.hello[0]!, protocol: 'eem/2' }),
    ).toThrow(EemProtocolError)
    expect(() => parseModuleRequest('ready', { extra: 1 })).toThrow(EemProtocolError)
    for (const path of ['/etc/passwd', '../x', 'a//b', 'a/./b', ''])
      expect(() => parseModuleRequest('data.get', { path })).toThrow(EemProtocolError)
    expect(() =>
      parseModuleRequest('tools.call', { name: 'members.list', input: { n: Infinity } }),
    ).toThrow()
  })
})

describe('eem/1 messages: kernel → module', () => {
  it.each(Object.entries(kernelCalls))(
    '%s round-trips request and result',
    (method, [params, res]) => {
      const [req] = roundTrip(request('k1', method, params))
      expect(parseKernelRequest(method, (req as { params: unknown }).params)).toEqual(params)
      const [ans] = roundTrip(result('k1', res))
      expect(
        parseKernelResult(
          method as keyof typeof KERNEL_TO_MODULE,
          (ans as { result: unknown }).result,
        ),
      ).toEqual(res)
    },
  )

  it('refuses a deadline over two minutes', () => {
    expect(() =>
      parseKernelRequest('tool.invoke', {
        ...(kernelCalls['tool.invoke'][0] as object),
        deadlineMs: 120_001,
      }),
    ).toThrow(EemProtocolError)
  })
})

describe('errors', () => {
  it('every module error is -32000 with data {code, message, detail}', () => {
    for (const code of MODULE_ERROR_CODES) {
      const e = eemError(code, `the ${code} sentence`)
      expect(e).toEqual({
        code: -32000,
        message: `the ${code} sentence`,
        data: { code, message: `the ${code} sentence`, detail: null },
      })
      const [msg] = roundTrip(errorResponse(3, e))
      expect(msg).toEqual({ jsonrpc: '2.0', id: 3, error: e })
    }
  })

  it('passes registry codes through, and carries detail', () => {
    const e = eemError('permission_denied', 'no', { tool: 'members.list' })
    expect(e.data).toEqual({
      code: 'permission_denied',
      message: 'no',
      detail: { tool: 'members.list' },
    })
  })

  it('lists exactly the U2 codes', () => {
    expect([...MODULE_ERROR_CODES].sort()).toEqual(
      [
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
      ].sort(),
    )
  })

  it('refuses anything that is not a JSON-RPC 2.0 request, result or error', () => {
    for (const bad of [
      null,
      1,
      {},
      { jsonrpc: '1.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } },
    ])
      expect(() => parseMessage(bad)).toThrow(EemProtocolError)
  })
})

describe('NDJSON framing', () => {
  it('reassembles lines across arbitrary chunking, including mid-UTF-8', () => {
    const a = encodeFrame(
      request(1, 'tools.call', { name: 'members.list', input: { q: 'Zoë 🎉' } }),
    )
    const b = encodeFrame(result(1, { ok: true }))
    const all = Buffer.concat([a, b])
    for (const size of [1, 2, 3, 7, all.byteLength]) {
      const d = new FrameDecoder()
      const out: EemMessage[] = []
      for (let i = 0; i < all.byteLength; i += size) out.push(...d.push(all.subarray(i, i + size)))
      expect(out).toEqual([JSON.parse(a.toString()), JSON.parse(b.toString())])
      expect(d.pending).toBe(0)
    }
  })

  it('caps a line at 4 MiB both ways', () => {
    const exactly = (bytes: number) => {
      const base = JSON.stringify(result(1, ''))
      return result(1, 'x'.repeat(bytes - base.length))
    }
    const atCap = encodeFrame(exactly(MAX_FRAME_BYTES))
    expect(atCap.byteLength).toBe(MAX_FRAME_BYTES + 1)
    expect(new FrameDecoder().push(atCap)).toHaveLength(1)
    expect(() => encodeFrame(exactly(MAX_FRAME_BYTES + 1))).toThrow(FrameTooLargeError)
    const d = new FrameDecoder()
    d.push(Buffer.alloc(MAX_FRAME_BYTES, 0x20))
    expect(() => d.push(Buffer.from(' '))).toThrow(FrameTooLargeError)
  })

  it('refuses invalid UTF-8, invalid JSON and empty lines', () => {
    expect(() => new FrameDecoder().push(Buffer.from([0xff, 0x0a]))).toThrow(/UTF-8/)
    expect(() => new FrameDecoder().push(Buffer.from('{nope\n'))).toThrow(/JSON/)
    expect(() => new FrameDecoder().push(Buffer.from('\n'))).toThrow(/empty/)
  })
})

describe('module tokens', () => {
  it('are 32 random bytes as hex, stored as sha256', () => {
    const t = newModuleToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(newModuleToken()).not.toBe(t)
    expect(moduleTokenHash(t)).toMatch(/^[0-9a-f]{64}$/)
    expect(moduleTokenHash(t)).not.toBe(t)
    expect(() => moduleTokenHash('short')).toThrow()
  })
})
