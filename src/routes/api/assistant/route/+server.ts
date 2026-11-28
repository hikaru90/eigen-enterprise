import type { RequestHandler } from './$types'
import { randomUUID } from 'node:crypto'
import { json } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { getUserRole, kernelRolesFor } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'

/**
 * The Ask bar's one door (plan/concept-memory-one-door.md M1): a client of memory.route_input,
 * run as the signed-in person with their own kernel roles — the same door the ee CLI, MCP and
 * the agent use. Every failure is an explicit error the bar shows; nothing is dropped silently.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'You must be signed in.' }, { status: 401 })
  const role = await getUserRole(locals.user.id)
  if (!role) return json({ error: 'Only members of this company have a company brain here.' }, { status: 403 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'The request body is not JSON.' }, { status: 400 })
  }
  try {
    const kernel = await appKernel()
    const result = await kernel.registry.execute('memory.route_input', body, {
      principal: { id: locals.user.id, kind: 'human', roles: kernelRolesFor(role) },
      requestId: randomUUID(),
    })
    return json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[assistant.route] failed', { userId: locals.user.id, error: message })
    if (err instanceof KernelError) {
      const status = err.code === 'invalid_input' ? 400 : err.code === 'permission_denied' ? 403 : 500
      return json({ error: message }, { status })
    }
    return json({ error: `The brain could not take this in: ${message}` }, { status: 502 })
  }
}
