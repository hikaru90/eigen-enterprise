import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * The co-workers suite's scripted model (C8): an OpenAI-compatible
 * `/chat/completions` the app's real gateway calls (PLATFORM_LLM_BASE_URL),
 * so every request a co-worker turn makes goes through the product's own LLM
 * client — model routing, the cost log, the trace — and arrives here, where
 * it is recorded and answered from a script.
 *
 * The script is the mock MODEL, not product logic: it answers by who is
 * asking (the role card line `You are <name> (@<handle>)` the turn's system
 * prompt opens with) and by who triggered the turn. A request no script
 * answers is forwarded to `upstream` (the e2e mock gateway, for the brain's
 * own chat turns in `--mode chat --provider mock`) or, without one, refused
 * with a 500 — never answered with made-up text.
 *
 * Every answer reports `usage.cost` (the platform contract: per-call cost in
 * the response), so the cost log holds a real, non-zero amount per call.
 */

export type ScriptedRequest = {
  model: string
  /** Every system message of the request, joined: the turn's assembled prompt. */
  system: string
  /** The latest user message (a co-worker turn's trigger: `<who>:\n<body>`). */
  input: string
  /** Role of the last message: `tool` once a tool result came back. */
  lastRole: string
  /** Names of the tools the request offers. */
  tools: string[]
}

export type ScriptedAnswer = { content: string } | { toolCall: { name: string; arguments: Record<string, unknown> } }

/** null: not this script's request. */
export type Script = (req: ScriptedRequest) => ScriptedAnswer | null

export type RecordedRequest = ScriptedRequest & { answered: 'script' | 'upstream' | 'refused' }

export type ScriptedGateway = {
  /** The origin; the app's PLATFORM_LLM_BASE_URL is `${origin}/v1`. */
  origin: string
  requests: RecordedRequest[]
  setScript(script: Script | null): void
  close(): Promise<void>
}

export const SCRIPTED_CALL_COST_USD = 0.0015

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (p && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n')
  return ''
}

/** The request as a script sees it (pure; exported for the spec). */
export function scriptedRequestOf(body: unknown): ScriptedRequest {
  const b = (body ?? {}) as { model?: unknown; messages?: unknown; tools?: unknown }
  const messages = Array.isArray(b.messages) ? (b.messages as Array<{ role?: unknown; content?: unknown }>) : []
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  return {
    model: typeof b.model === 'string' ? b.model : '',
    system: messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n'),
    input: textOf(lastUser?.content),
    lastRole: typeof messages.at(-1)?.role === 'string' ? (messages.at(-1)!.role as string) : '',
    tools: (Array.isArray(b.tools) ? (b.tools as Array<{ function?: { name?: unknown } }>) : [])
      .map((t) => t.function?.name)
      .filter((n): n is string => typeof n === 'string'),
  }
}

let seq = 0

/** The chat-completions response for a scripted answer (pure; exported for the spec). */
export function completionOf(model: string, answer: ScriptedAnswer, costUsd = SCRIPTED_CALL_COST_USD): Record<string, unknown> {
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: costUsd }
  if ('toolCall' in answer) {
    seq += 1
    return {
      id: `scripted-${seq}`,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `call_scripted_${seq}`, type: 'function', function: { name: answer.toolCall.name, arguments: JSON.stringify(answer.toolCall.arguments) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    }
  }
  return { id: 'scripted', model, choices: [{ index: 0, message: { role: 'assistant', content: answer.content }, finish_reason: 'stop' }], usage }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw
}

export async function startScriptedGateway(opts: { upstream: string | null }): Promise<ScriptedGateway> {
  let script: Script | null = null
  const requests: RecordedRequest[] = []

  const forward = async (req: IncomingMessage, raw: string, res: ServerResponse) => {
    const upstream = await fetch(`${opts.upstream}${req.url ?? ''}`, {
      method: req.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: String(req.headers.authorization ?? '') },
      ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: raw }),
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(await upstream.text())
  }
  const refuse = (res: ServerResponse, message: string) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message } }))
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      if (req.method === 'POST' && (req.url ?? '').endsWith('/chat/completions')) {
        const body = JSON.parse(raw) as unknown
        const seen = scriptedRequestOf(body)
        const answer = script?.(seen) ?? null
        if (answer) {
          requests.push({ ...seen, answered: 'script' })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(completionOf(seen.model, answer)))
          return
        }
        requests.push({ ...seen, answered: opts.upstream ? 'upstream' : 'refused' })
        if (opts.upstream) return forward(req, raw, res)
        return refuse(res, 'scripted gateway: no script answers this request and there is no upstream')
      }
      if (opts.upstream) return forward(req, raw, res)
      return refuse(res, `scripted gateway: no route for ${req.method} ${req.url}`)
    })().catch((err: unknown) => refuse(res, `scripted gateway failed: ${err instanceof Error ? err.message : String(err)}`))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('the scripted gateway has no address')
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    requests,
    setScript: (s) => {
      script = s
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
