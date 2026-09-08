/**
 * Minimal OpenRouter-compatible mock gateway for e2e (playwright webServer).
 *
 * The first-run onboarding wizard verifies credentials with a REAL server-side gateway
 * call before saving — so e2e needs a gateway that actually answers. This fixture:
 *   POST /v1/chat/completions  → 1-token assistant reply (requires Bearer auth)
 *   GET  /v1/routing-rules/:id → { data: { model } }
 *   everything else            → 404
 */
import http from 'node:http'

const port = Number(process.env.MOCK_GATEWAY_PORT ?? 5199)

const server = http.createServer((req, res) => {
  const url = req.url ?? ''
  const auth = req.headers.authorization ?? ''

  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (!auth.startsWith('Bearer ') || auth.length <= 'Bearer '.length) {
    send(401, { error: { message: 'Missing or malformed Authorization header' } })
    return
  }

  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let model = 'mock-chat-model'
      try {
        const body = JSON.parse(raw)
        if (typeof body.model === 'string' && body.model) model = body.model
      } catch {
        // keep default model
      }
      send(200, {
        id: 'mock-completion',
        model,
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    })
    return
  }

  const ruleMatch = req.method === 'GET' ? url.match(/\/routing-rules\/([^/]+)$/) : null
  if (ruleMatch) {
    send(200, { data: { model: `mock-rule-model`, provider: { data_residency: 'EU' } } })
    return
  }

  send(404, { error: { message: `mock gateway has no route for ${req.method} ${url}` } })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-gateway] listening on http://127.0.0.1:${port}`)
})
