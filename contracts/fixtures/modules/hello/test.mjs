// hello's test: a stand-in kernel on a Unix socket, the module spawned against
// it. No network, no secrets (ee runs it with PrivateNetwork=yes).
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'hello-test-'))
const socket = join(dir, 'kernel.sock')
const token = 'ab'.repeat(32)
const commit = 'c0'.repeat(20)
const seen = []

const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('hello did not finish within 10 s')), 10_000)
  const server = createServer((conn) => {
    const send = (msg) => conn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', (chunk) => {
      buf += chunk
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        seen.push(msg.method ?? `answer:${msg.id}`)
        if (msg.method === 'hello') {
          assert.deepEqual(msg.params, { protocol: 'eem/1', moduleId: 'hello', commit, token })
          send({
            id: msg.id,
            result: {
              coreApi: '1.0.0',
              heartbeatMs: 50,
              grants: { background: false, secrets: [] },
            },
          })
        } else if (msg.method === 'ready') {
          send({ id: msg.id, result: {} })
          send({
            id: 'k1',
            method: 'tool.invoke',
            params: {
              callId: 'c1',
              tool: 'greet',
              input: { name: 'Ada' },
              principal: { id: 'u1', kind: 'human', roles: ['member'] },
              deadlineMs: 5000,
            },
          })
        } else if (msg.method === 'heartbeat') {
          send({ id: msg.id, result: {} })
          if (seen.includes('answer:k1'))
            send({ id: 'k2', method: 'shutdown', params: { reason: 'test over' } })
        } else if (msg.id === 'k1') {
          assert.deepEqual(msg.result, { greeting: 'Hello, Ada!' })
        } else if (msg.id === 'k2') {
          clearTimeout(timer)
          server.close()
          resolve()
        }
      }
    })
  })
  server.listen(socket, () => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'index.mjs')], {
      env: {
        EE_MODULE_SOCKET: socket,
        EE_MODULE_ID: 'hello',
        EE_MODULE_COMMIT: commit,
        EE_MODULE_TOKEN: token,
        PATH: process.env.PATH ?? '',
      },
      stdio: 'inherit',
    })
    child.on('exit', (code) => code !== 0 && reject(new Error(`hello exited with ${code}`)))
  })
})

try {
  await done
  assert.ok(seen.includes('heartbeat'), 'hello sent a heartbeat')
  console.info('ok hello: hello → ready → greet → heartbeat → shutdown')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
