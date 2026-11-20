import { randomUUID } from 'node:crypto'
import { json, type RequestEvent } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { isAdminRole } from '$lib/server/auth/roles'
import { getUserRole } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { DRIVE_STATUS, driveErrorBody } from '../../../modules/drive/http'
import { DriveError } from '../../../modules/drive/service'

/**
 * The Drive folder page's app controls run the drive.app_* registry tools as
 * the signed-in person (no UI-only actions: the CLI, MCP and the agent get the
 * same tools). The kernel role is the person's own (owner/admin → admin,
 * member → member); the tools check the company role again for Run and Stop.
 * Errors come back the way the Drive client reads them: { error, code } with
 * the Drive status (busy → 409 with `running`), kernel refusals by their own.
 */
export async function driveAppTool(event: Pick<RequestEvent, 'locals'>, tool: 'drive.app_status' | 'drive.app_run' | 'drive.app_stop', input: unknown): Promise<Response> {
  const user = event.locals.user
  if (!user) return json({ error: 'Sign in to use Drive.', code: 'unauthorized' }, { status: 401 })
  const roles = isAdminRole(await getUserRole(user.id)) ? ['admin'] : ['member']
  try {
    const kernel = await appKernel()
    return json(await kernel.registry.execute(tool, input, { principal: { id: user.id, kind: 'human', roles }, requestId: randomUUID() }))
  } catch (err) {
    if (err instanceof DriveError) return json(driveErrorBody(err), { status: DRIVE_STATUS[err.code] })
    if (err instanceof KernelError) {
      const status = err.toProblemJson().status
      const message = err.code === 'permission_denied' ? 'Only an owner or admin can run or stop apps in Drive.' : err.message
      return json({ error: message, code: err.code }, { status })
    }
    throw err
  }
}
