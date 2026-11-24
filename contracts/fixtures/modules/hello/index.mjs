// hello — the U2 fixture module, speaking raw eem/1 (plan/phase-upgrades-u2.md §4)
// over EE_MODULE_SOCKET: NDJSON, one JSON-RPC 2.0 message per line.
import { connect } from 'node:net'

const env = (name) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}
const SOCKET = env('EE_MODULE_SOCKET')
const MAX_LINE = 4 * 1024 * 1024
const RETRY_MS = 1000
const GIVE_UP_MS = 120_000

function greet(input) {
  return { greeting: `Hello, ${input.name}!` }
}

const tools = { greet }
let firstFailure = null

function session() {
  const sock = connect(SOCKET)
  let nextId = 1
  let heartbeat = null
  const waiting = new Map()
  const send = (msg) => sock.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      send({ id, method, params })
    })
  const fail = (id, code, message) =>
    send({ id, error: { code: -32000, message, data: { code, message, detail: null } } })

  const handle = (msg) => {
    if (!('method' in msg)) {
      const w = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (w && msg.error) w.reject(new Error(msg.error.message))
      else if (w) w.resolve(msg.result)
      return
    }
    if (msg.method === 'tool.invoke') {
      const tool = tools[msg.params.tool]
      if (!tool) return fail(msg.id, 'invalid_input', `hello has no tool "${msg.params.tool}"`)
      return send({ id: msg.id, result: tool(msg.params.input) })
    }
    if (msg.method === 'event.deliver') return send({ id: msg.id, result: {} })
    if (msg.method === 'shutdown') {
      send({ id: msg.id, result: {} })
      sock.end(() => process.exit(0))
      return
    }
    fail(msg.id, 'module_protocol', `hello does not answer "${msg.method}"`)
  }

  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    if (buf.length > MAX_LINE) throw new Error('a line from the kernel is over 4 MiB')
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      handle(JSON.parse(line))
    }
  })
  sock.on('connect', async () => {
    firstFailure = null
    const welcome = await call('hello', {
      protocol: 'eem/1',
      moduleId: env('EE_MODULE_ID'),
      commit: env('EE_MODULE_COMMIT'),
      token: env('EE_MODULE_TOKEN'),
    })
    await call('ready', {})
    heartbeat = setInterval(
      () => call('heartbeat', {}).catch(() => sock.destroy()),
      welcome.heartbeatMs,
    )
  })
  sock.on('error', () => {})
  sock.on('close', () => {
    clearInterval(heartbeat)
    firstFailure ??= Date.now()
    if (Date.now() - firstFailure > GIVE_UP_MS) process.exit(1)
    setTimeout(session, RETRY_MS)
  })
}

session()
