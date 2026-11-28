import type { TraceHubDeps, TraceHubReply, TraceHubRequest } from '../../../../modules/traces/hub/service'
import { json } from '@sveltejs/kit'

/**
 * /api/hub/traces plumbing (plan/traces-phone-home.md T3): machine endpoints called by boxes
 * without a session, authenticated by the install signature the Contribute hub checks (one
 * identity per install, its replay + rate limits included). 404 while the trace-hub module is
 * off. HubError / TraceHubError → their status; anything else is a logged 500.
 */

export type TraceHubRuntime = { active: () => Promise<boolean>; deps: () => Promise<TraceHubDeps> }

export const liveTraceHubRuntime: TraceHubRuntime = {
  active: async () => (await import('../../../../modules/traces/hub/live')).traceHubActive(),
  deps: async () => {
    const [{ traceHubReadDeps }, { contributeHubDeps }, { authenticate }] = await Promise.all([
      import('../../../../modules/traces/hub/live'),
      import('../../../../modules/contribute/hub/live'),
      import('../../../../modules/contribute/hub/service'),
    ])
    const read = await traceHubReadDeps()
    const contribute = await contributeHubDeps()
    return {
      ...read,
      authenticate: async (req) => ({ installId: (await authenticate(contribute, req)).installId }),
    }
  },
}

export async function traceHubRoute(
  runtime: TraceHubRuntime,
  request: Request,
  url: URL,
  run: (deps: TraceHubDeps, req: TraceHubRequest) => Promise<TraceHubReply>,
): Promise<Response> {
  if (!(await runtime.active())) return json({ error: 'Not found', code: 'not_found' }, { status: 404 })
  const [{ HubError, HUB_ERROR_STATUS }, { TraceHubError, TRACE_HUB_ERROR_STATUS }] = await Promise.all([
    import('../../../../modules/contribute/hub/errors'),
    import('../../../../modules/traces/hub/service'),
  ])
  try {
    // The raw body, read once: the signature covers exactly these bytes.
    const body = await request.text()
    const out = await run(await runtime.deps(), { method: request.method, path: url.pathname, headers: request.headers, body })
    return json(out.body, { status: out.status })
  } catch (err) {
    if (err instanceof HubError) return json({ error: err.message, code: err.code }, { status: HUB_ERROR_STATUS[err.code] })
    if (err instanceof TraceHubError) return json({ error: err.message, code: err.code }, { status: TRACE_HUB_ERROR_STATUS[err.code] })
    console.error('[trace-hub] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
