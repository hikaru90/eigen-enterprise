/**
 * Mock GitHub for e2e (plan/github-drive-full-mirror.md §8 M4), served as a
 * Playwright webServer next to the mock gateway and the mock hub. Two
 * origins, like GitHub: the REST API (the harness app's
 * GITHUB_TOKEN_API_BASE_URL) and codeload (GITHUB_CODELOAD_BASE_URL), where
 * the tarball redirect points. The logic is mock-github-core.ts.
 *
 * Test-only endpoints on the API port:
 *   GET /__mock-github/health   → { ok: true } (Playwright's readiness URL)
 *   GET /__mock-github/requests → { requests } every request, oldest first
 *
 * Run: `tsx scripts/mock-github.ts` (MOCK_GITHUB_PORT, default 5197;
 * MOCK_GITHUB_CODELOAD_PORT, default 5196).
 */
import http from 'node:http'
import { createMockGitHub, type MockGitHubAnswer } from './mock-github-core'

const port = Number(process.env.MOCK_GITHUB_PORT ?? 5197)
const codeloadPort = Number(process.env.MOCK_GITHUB_CODELOAD_PORT ?? 5196)
const github = createMockGitHub({ codeloadOrigin: `http://127.0.0.1:${codeloadPort}` })

function send(res: http.ServerResponse, a: MockGitHubAnswer) {
  res.writeHead(a.status, a.headers)
  res.end(typeof a.body === 'string' ? a.body : Buffer.from(a.body))
}

const api = http.createServer((req, res) => {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'
  const path = url.split('?')[0]
  if (method === 'GET' && path === '/__mock-github/health') {
    send(res, { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) })
    return
  }
  if (method === 'GET' && path === '/__mock-github/requests') {
    send(res, { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests: github.requests }) })
    return
  }
  const out = github.api(method, url, req.headers)
  console.log(`[mock-github] ${method} ${path} → ${out.status}`)
  send(res, out)
})

const codeload = http.createServer((req, res) => {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'
  github.codeload(method, url, req.headers).then(
    (out) => {
      console.log(`[mock-github] codeload ${method} ${url.split('?')[0]} → ${out.status}`)
      send(res, out)
    },
    (err: unknown) => {
      console.error('[mock-github] codeload failed', err)
      send(res, { status: 500, headers: { 'content-type': 'text/plain' }, body: 'mock codeload failed' })
    },
  )
})

api.listen(port, '127.0.0.1', () => console.log(`[mock-github] API on http://127.0.0.1:${port}`))
codeload.listen(codeloadPort, '127.0.0.1', () => console.log(`[mock-github] codeload on http://127.0.0.1:${codeloadPort}`))
