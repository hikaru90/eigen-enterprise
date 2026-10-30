/**
 * Mock fixtures for e2e, served as a second playwright webServer.
 *
 * 1. OpenRouter-compatible LLM gateway (/v1) — the onboarding wizard verifies
 *    credentials with a REAL server-side gateway call, so e2e needs a gateway that
 *    actually answers. Chat completions answer with NATIVE tool_calls then a
 *    plain answer; prompt markers [mock-tool:<name>] / [mock-delay:<ms>] and env
 *    MOCK_GATEWAY_DELAY_MS are documented in scripts/mock-gateway-chat.mjs.
 * 2. models.dev catalog fixture (/models.dev.json) — MODELS_DEV_CATALOG_URL override.
 * 3. GitHub device-flow + Copilot token stubs (/gh/*, /copilot_internal/*) —
 *    OAUTH_GITHUB_BASE_URL / OAUTH_GITHUB_API_BASE_URL overrides.
 */
import http from 'node:http'
import { mockChatCompletion } from './mock-gateway-chat.mjs'

const port = Number(process.env.MOCK_GATEWAY_PORT ?? 5199)

const CATALOG_FIXTURE = {
  'github-copilot': {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    env: ['GITHUB_COPILOT_TOKEN'],
    npm: '@ai-sdk/openai-compatible',
    api: `http://127.0.0.1:${port}/v1`,
    models: {
      'mock-copilot-chat': {
        id: 'mock-copilot-chat',
        name: 'Mock Copilot Chat',
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    env: ['OPENROUTER_API_KEY'],
    npm: '@openrouter/ai-sdk-provider',
    api: 'https://openrouter.ai/api/v1',
    models: {
      'mock/openrouter-chat': {
        id: 'mock/openrouter-chat',
        name: 'Mock OpenRouter Chat',
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  mockgroq: {
    id: 'mockgroq',
    name: 'MockGroq',
    env: ['MOCKGROQ_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    api: `http://127.0.0.1:${port}/v1`,
    doc: 'https://mock.test/docs',
    models: {
      'mock-chat-model': {
        id: 'mock-chat-model',
        name: 'Mock Chat Model',
        modalities: { input: ['text'], output: ['text'] },
      },
      'mock-embed-model': {
        id: 'mock-embed-model',
        name: 'Mock Embed Model',
        modalities: { input: ['text'], output: ['embedding'] },
      },
    },
  },
}

let devicePollCount = 0

const server = http.createServer((req, res) => {
  const url = req.url ?? ''
  const auth = req.headers.authorization ?? ''

  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // --- models.dev catalog fixture --------------------------------------------
  if (req.method === 'GET' && url === '/models.dev.json') {
    send(200, CATALOG_FIXTURE)
    return
  }

  // --- GitHub device flow stubs ------------------------------------------------
  if (req.method === 'POST' && url === '/gh/login/device/code') {
    devicePollCount = 0
    send(200, {
      device_code: 'mock-device-code',
      user_code: 'TEST-CODE',
      verification_uri: `http://127.0.0.1:${port}/gh/login/device`,
      interval: 1,
      expires_in: 900,
    })
    return
  }
  if (req.method === 'POST' && url === '/gh/login/oauth/access_token') {
    devicePollCount += 1
    if (devicePollCount === 1) {
      send(200, { error: 'authorization_pending', interval: 1 })
    } else {
      send(200, { access_token: 'gho_mock_token', token_type: 'bearer' })
    }
    return
  }

  // --- Copilot token + models (auth: Bearer GitHub token) ----------------------
  if (req.method === 'GET' && url === '/copilot_internal/v2/token') {
    if (!auth.startsWith('Bearer ')) {
      send(401, { error: 'bad auth' })
      return
    }
    send(200, {
      token: `tid=mock;exp=${Math.floor(Date.now() / 1000) + 1800};proxy-ep=proxy.individual.githubcopilot.com`,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    })
    return
  }
  if (req.method === 'GET' && url === '/models') {
    if (!auth.startsWith('Bearer ')) {
      send(401, { error: 'bad auth' })
      return
    }
    send(200, { data: [{ id: 'gpt-4.1' }, { id: 'claude-3.7' }] })
    return
  }

  // --- OpenAI-compatible gateway (/v1) -----------------------------------------
  if (!auth.startsWith('Bearer ') || auth.length <= 'Bearer '.length) {
    send(401, { error: { message: 'Missing or malformed Authorization header' } })
    return
  }
  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        send(400, { error: { message: 'mock gateway: request body is not JSON' } })
        return
      }
      // Native tool_calls + optional delay: see scripts/mock-gateway-chat.mjs.
      const { delayMs, response } = mockChatCompletion(body, process.env)
      if (delayMs > 0) {
        console.log(`[mock-gateway] delaying completion ${delayMs} ms`)
        setTimeout(() => send(200, response), delayMs)
      } else {
        send(200, response)
      }
    })
    return
  }
  const ruleMatch = req.method === 'GET' ? url.match(/\/routing-rules\/([^/]+)$/) : null
  if (ruleMatch) {
    send(200, { data: { model: 'mock-rule-model', provider: { data_residency: 'EU' } } })
    return
  }

  send(404, { error: { message: `mock gateway has no route for ${req.method} ${url}` } })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-gateway] listening on http://127.0.0.1:${port}`)
})
