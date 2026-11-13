/**
 * Mock central Contribute board for e2e (plan/contribute-phone-home.md §6
 * step 5), served as a Playwright webServer next to the mock gateway. The
 * harness app sends to it through CONTRIBUTE_HUB_URL.
 *
 * The hub logic (contract-checked, signature-verified) is mock-hub-core.ts.
 *
 * Test-only read endpoint:
 *   GET /__mock-hub/requests → { requests } every request received, oldest
 *                              first: method, path, install id, the raw body,
 *                              whether its signature held, the answer.
 *
 * Run: `tsx scripts/mock-hub.ts` (MOCK_HUB_PORT, default 5198).
 */
import http from 'node:http'
import { createMockHub } from './mock-hub-core'

const port = Number(process.env.MOCK_HUB_PORT ?? 5198)
const hub = createMockHub()

const server = http.createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  const method = req.method ?? 'GET'
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (method === 'GET' && path === '/__mock-hub/requests') {
    send(200, { requests: hub.requests })
    return
  }
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk: string) => (raw += chunk))
  req.on('end', () => {
    const out = hub.receive(method, path, req.headers, raw)
    console.log(`[mock-hub] ${method} ${path} → ${out.status}`)
    send(out.status, out.answer)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-hub] listening on http://127.0.0.1:${port}`)
})
