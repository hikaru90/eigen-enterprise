import type { CrawlCall } from './crawl'

/**
 * Driving the real chat path as a member: the `/api/chat` POST handler
 * itself (handleAgentChatPost → AgentRuntime.dispatch → the orchestrator),
 * called in-process with the member signed in, inside the same per-request
 * DB scope hooks.server.ts gives a request. The stream is read like the
 * chatbox reads it.
 *
 * The stream carries the reply but not tool outputs, so the registry is
 * tapped (observed, not changed) to record each turn's tool calls — the
 * provenance a leak or a citation is checked against.
 */

export type ParsedTurn = { reply: string; sessionId: string | null; error: string | null; approvals: string[]; previews: string[] }

export function parseChatNdjson(text: string): ParsedTurn {
  let deltas = ''
  let reply: string | null = null
  let sessionId: string | null = null
  let error: string | null = null
  const approvals: string[] = []
  const previews: string[] = []
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error(`chat stream line ${i + 1} is not JSON`)
    }
    if (frame.type === 'message_delta' && typeof frame.content === 'string') deltas += frame.content
    else if (frame.type === 'tool.preview' && typeof frame.tool === 'string') previews.push(frame.tool)
    else if (frame.type === 'approval.required' && typeof frame.tool === 'string') approvals.push(frame.tool)
    else if (frame.type === 'done') {
      reply = typeof frame.response === 'string' ? frame.response : deltas
      sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : null
    } else if (frame.type === 'error') error = typeof frame.error === 'string' ? frame.error : JSON.stringify(frame.error)
  }
  if (reply === null && error === null) error = 'the stream ended without a done or error frame'
  return { reply: reply ?? deltas, sessionId, error, approvals, previews }
}

type Executes = { execute: (tool: string, input: unknown, ctx: { principal: { id: string } }) => Promise<unknown> }

export type ToolTap = { take(userId: string): CrawlCall[] }

/**
 * Wraps `registry.execute` to record every call per person (CB3: the brain's
 * calls run as the member, so the principal id IS the person); behaviour is
 * unchanged.
 */
export function tapToolCalls(registry: Executes): ToolTap {
  const byUser = new Map<string, CrawlCall[]>()
  const original = registry.execute.bind(registry)
  const record = (userId: string | undefined, call: CrawlCall) => {
    const key = userId ?? '(none)'
    byUser.set(key, [...(byUser.get(key) ?? []), call])
  }
  registry.execute = async (tool, input, ctx) => {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    try {
      const out = await original(tool, input, ctx)
      record(ctx.principal.id, { tool, input: args, ok: true, output: JSON.stringify(out) ?? 'undefined' })
      return out
    } catch (err) {
      record(ctx.principal.id, { tool, input: args, ok: false, output: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
      throw err
    }
  }
  return {
    take(userId) {
      const calls = byUser.get(userId) ?? []
      byUser.delete(userId)
      return calls
    },
  }
}

export type ChatMember = { id: string; name: string; email: string; role: string }

/** One chat turn as `member`: POST /api/chat (NDJSON), read to the end. */
export async function chatAs(member: ChatMember, message: string, sessionId?: string): Promise<ParsedTurn> {
  const { POST } = await import('../../src/routes/api/chat/+server')
  const { withEvalDb } = await import('../harness/eval-context')
  const request = new Request('http://eval.localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }),
  })
  const now = new Date()
  const locals = {
    user: { id: member.id, name: member.name, email: member.email, role: member.role, emailVerified: true, createdAt: now, updatedAt: now },
    session: { id: `eval-${member.id}`, userId: member.id, token: 'eval', expiresAt: new Date(now.getTime() + 3600_000), createdAt: now, updatedAt: now },
  }
  const event = { request, locals, url: new URL(request.url), params: {}, route: { id: '/api/chat' } } as unknown as Parameters<typeof POST>[0]
  const response = await withEvalDb(member.id, () => POST(event) as Promise<Response>)
  return parseChatNdjson(await response.text())
}
