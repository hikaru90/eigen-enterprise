/**
 * Mock fixtures for e2e, served as a second playwright webServer.
 *
 * 1. OpenRouter-compatible LLM gateway (/v1) — the onboarding wizard verifies
 *    credentials with a REAL server-side gateway call, so e2e needs a gateway that
 *    actually answers.
 * 2. models.dev catalog fixture (/models.dev.json) — MODELS_DEV_CATALOG_URL override.
 * 3. GitHub device-flow + Copilot token stubs (/gh/*, /copilot_internal/*) —
 *    OAUTH_GITHUB_BASE_URL / OAUTH_GITHUB_API_BASE_URL overrides.
 */
import http from 'node:http'

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
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    api: 'https://api.anthropic.com/v1',
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  'openai-codex': {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    env: [],
    npm: '@ai-sdk/openai-compatible',
    api: `http://127.0.0.1:${port}/v1`,
    models: {
      'gpt-5.1-codex': {
        id: 'gpt-5.1-codex',
        name: 'GPT-5.1 Codex',
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
let claudeMessageCalls = 0
let codexResponseCalls = 0
let gatewayChatCalls = 0

function mockJwt() {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-e2e' } }),
  ).toString('base64url')
  return `e30.${payload}.sig`
}

const server = http.createServer((req, res) => {
  const url = req.url ?? ''
  const auth = req.headers.authorization ?? ''

  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // --- Claude (Anthropic OAuth) stubs --------------------------------------------
  if (req.method === 'GET' && url.startsWith('/claude/authorize')) {
    const parsed = new URL(url, 'http://x')
    const state = parsed.searchParams.get('state') ?? ''
    res.writeHead(302, {
      location: `http://localhost:53692/callback?code=mock-claude-code&state=${encodeURIComponent(state)}`,
    })
    res.end()
    return
  }
  if (req.method === 'POST' && url === '/claude/v1/oauth/token') {
    send(200, { access_token: 'sk-ant-oat-mock', refresh_token: 'refresh-mock', expires_in: 3600 })
    return
  }
  if (req.method === 'POST' && url === '/claude/v1/messages') {
    if (!auth.startsWith('Bearer sk-ant-oat')) {
      send(401, { error: { message: 'bad claude token' } })
      return
    }
    claudeMessageCalls += 1
    send(200, {
      id: 'msg-mock',
      model: 'claude-sonnet-4-5',
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify(claudeMessageCalls % 2 === 1 ? { tool: 'list_projects', arguments: {} } : { answer: `Hello from mock Claude. (call ${claudeMessageCalls})` }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    })
    return
  }

  // --- OpenAI Codex (ChatGPT OAuth) stubs ------------------------------------------
  if (req.method === 'POST' && url === '/openai/api/accounts/deviceauth/usercode') {
    devicePollCount = 0
    send(200, { device_auth_id: 'da-mock', user_code: 'TEST-CODE', interval: 1 })
    return
  }
  if (req.method === 'POST' && url === '/openai/api/accounts/deviceauth/token') {
    devicePollCount += 1
    if (devicePollCount === 1) {
      send(403, { error: { code: 'deviceauth_authorization_pending' } })
    } else {
      send(200, { authorization_code: 'ac-mock', code_verifier: 'cv-mock' })
    }
    return
  }
  if (req.method === 'POST' && url === '/openai/oauth/token') {
    send(200, {
      access_token: mockJwt(),
      refresh_token: 'refresh-mock',
      expires_in: 3600,
    })
    return
  }
  if (req.method === 'POST' && url === '/codex/responses') {
    if (!auth.startsWith('Bearer ')) {
      send(401, { error: { message: 'bad codex token' } })
      return
    }
    codexResponseCalls += 1
    const sse = [
      `data: ${JSON.stringify({ type: 'response.created' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(codexResponseCalls % 2 === 1 ? { tool: 'list_projects', arguments: {} } : { answer: `Hello from mock Codex. (call ${codexResponseCalls})` }) })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.1-codex',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(codexResponseCalls % 2 === 0 ? { answer: `Hello from mock Codex. (call ${codexResponseCalls})` } : { tool: 'list_projects', arguments: {} }) }] }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      })}\n\n`,
    ].join('')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse)
    return
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
      let model = 'mock-chat-model'
      let isPing = false
      try {
        const body = JSON.parse(raw)
        if (typeof body.model === 'string' && body.model) model = body.model
        if (body.max_tokens === 1) isPing = true // connection-test ping: any text reply works
      } catch {
        // keep default model
      }
      let content = 'pong'
      if (!isPing) {
        gatewayChatCalls += 1
        content =
          gatewayChatCalls % 2 === 1
            ? JSON.stringify({ tool: 'list_projects', arguments: {} })
            : JSON.stringify({ answer: 'Hello from mock gateway.' })
      }
      send(200, {
        id: 'mock-completion',
        model,
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
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
