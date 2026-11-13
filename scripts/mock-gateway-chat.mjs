/**
 * Chat-completion behaviour of the mock gateway (scripts/mock-gateway.mjs),
 * kept pure so it is unit-tested (mock-gateway-chat.spec.ts).
 *
 * The durable engine (the only engine since 2026-10-20) expects NATIVE OpenAI
 * `tool_calls`, so a turn looks like a real provider's:
 *   1. latest message is the user's and the request offers the chosen tool →
 *      assistant message with one `tool_calls` entry (finish_reason tool_calls);
 *   2. the tool result came back (latest message role `tool`), or no tool is
 *      offered/chosen → plain answer MOCK_ANSWER (finish_reason stop).
 * A connection-test ping (max_tokens 1) answers "pong".
 *
 * Prompt markers (read from the LATEST user message, so they hold for every
 * completion of that turn, including ones replayed after a server restart):
 *   [mock-tool:<name>]  call <name> instead of DEFAULT_MOCK_TOOL;
 *                       [mock-tool:none] answers without a tool call.
 *   [mock-delay:<ms>]   hold every completion of the turn for <ms> before
 *                       answering — lets a test restart the server mid-turn.
 *   [mock-json:<b64url>] answer with exactly the base64url-decoded text as
 *                       content (no tool call) — e.g. a JSON verdict for an
 *                       LLM judge (the Contribute board's kind/area/duplicate).
 *   [mock-json@<Tag>:<b64url>] the same, but only for a call whose latest user
 *                       message opens with "<Tag>:" — it wins over the plain
 *                       marker there. Lets one text answer two different calls,
 *                       e.g. the Contribute judge ("Draft:") and the sharing
 *                       scrub ("Proposal:") of the same proposal.
 * Env:
 *   MOCK_GATEWAY_DELAY_MS  default delay for every non-ping completion
 *                          (the prompt marker wins). Malformed → throws.
 */

// Read-only and always offered: the website module is in the baseline install.
export const DEFAULT_MOCK_TOOL = 'website.list_pages'
export const MOCK_ANSWER = 'Hello from mock gateway.'

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
  }
  return ''
}

function envDelay(env) {
  const raw = env.MOCK_GATEWAY_DELAY_MS
  if (raw === undefined || raw === '') return 0
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `MOCK_GATEWAY_DELAY_MS must be a non-negative integer (ms), got ${JSON.stringify(raw)}`,
    )
  }
  return Number(raw)
}

let callSeq = 0

/**
 * @param {any} body parsed request body
 * @param {Record<string, string | undefined>} env
 * @returns {{ delayMs: number, response: any }}
 */
export function mockChatCompletion(body, env) {
  const model = typeof body?.model === 'string' && body.model ? body.model : 'mock-chat-model'
  const wrap = (message, finishReason) => ({
    id: 'mock-completion',
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  const defaultDelay = envDelay(env)
  if (body?.max_tokens === 1) {
    return { delayMs: 0, response: wrap({ role: 'assistant', content: 'pong' }, 'stop') }
  }

  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user')
  const userText = textOf(lastUser?.content)
  const delayMarker = userText.match(/\[mock-delay:(\d+)\]/)
  const delayMs = delayMarker ? Number(delayMarker[1]) : defaultDelay

  const tag = userText.match(/^([A-Za-z]+):/)?.[1]
  const tagged = tag
    ? [...userText.matchAll(/\[mock-json@([A-Za-z]+):([A-Za-z0-9_-]+)\]/g)].find((m) => m[1] === tag)
    : undefined
  const jsonMarker = tagged ? [tagged[0], tagged[2]] : userText.match(/\[mock-json:([A-Za-z0-9_-]+)\]/)
  if (jsonMarker) {
    const content = Buffer.from(jsonMarker[1], 'base64url').toString('utf8')
    return { delayMs, response: wrap({ role: 'assistant', content }, 'stop') }
  }

  const toolMarker = userText.match(/\[mock-tool:([A-Za-z0-9_.-]+)\]/)
  const wanted = toolMarker ? toolMarker[1] : DEFAULT_MOCK_TOOL
  const offered = (Array.isArray(body?.tools) ? body.tools : []).map((t) => t?.function?.name)
  const last = messages[messages.length - 1]

  if (last?.role === 'user' && wanted !== 'none' && offered.includes(wanted)) {
    callSeq += 1
    return {
      delayMs,
      response: wrap(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_mock_${Date.now()}_${callSeq}`,
              type: 'function',
              function: { name: wanted, arguments: '{}' },
            },
          ],
        },
        'tool_calls',
      ),
    }
  }
  return { delayMs, response: wrap({ role: 'assistant', content: MOCK_ANSWER }, 'stop') }
}
