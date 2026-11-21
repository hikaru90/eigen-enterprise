import { randomUUID } from 'node:crypto'
import { json, type RequestEvent } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { isAdminRole } from '$lib/server/auth/roles'
import { getUserRole } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { driveErrorReport } from '$lib/server/drive'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { DRIVE_STATUS } from '../../../modules/drive/http'
import { DriveError } from '../../../modules/drive/service'

/**
 * The Drive folder page's app controls run the drive.app_* registry tools as
 * the signed-in person (no UI-only actions: the CLI, MCP and the agent get the
 * same tools). The kernel role is the person's own (owner/admin → admin,
 * member → member); the tools check the company role again for Run and Stop.
 * Errors come back the way the Drive client reads them: { error, code } with
 * the Drive status (busy → 409 with `running`), kernel refusals by their own.
 */
const ATTEMPTED: Record<'drive.app_status' | 'drive.app_run' | 'drive.app_stop', string> = {
  'drive.app_status': 'Reading the state of a Drive folder’s app preview',
  'drive.app_run': 'Running a Drive folder as an app preview',
  'drive.app_stop': 'Stopping a Drive app preview',
}

export async function driveAppTool(
  event: Pick<RequestEvent, 'locals'>,
  tool: 'drive.app_status' | 'drive.app_run' | 'drive.app_stop',
  input: unknown,
): Promise<Response> {
  const user = event.locals.user
  const attempted = ATTEMPTED[tool]
  if (!user)
    return json(
      {
        ...refusalReport('Sign in to use Drive.', {
          attempted,
          tool,
          input,
          cause: 'No session on the request.',
        }),
        code: 'unauthorized',
      },
      { status: 401 },
    )
  const roles = isAdminRole(await getUserRole(user.id)) ? ['admin'] : ['member']
  try {
    const kernel = await appKernel()
    return json(
      await kernel.registry.execute(tool, input, {
        principal: { id: user.id, kind: 'human', roles },
        requestId: randomUUID(),
      }),
    )
  } catch (err) {
    if (err instanceof DriveError)
      return json(driveErrorReport(err, { attempted, tool, input }), {
        status: DRIVE_STATUS[err.code],
      })
    if (err instanceof KernelError) {
      const status = err.toProblemJson().status
      const plain = () =>
        err.code === 'permission_denied'
          ? 'Only an owner or admin can run or stop apps in Drive.'
          : err.message
      return json(
        { ...errorReport(err, { attempted, tool, input, plain }), code: err.code },
        { status },
      )
    }
    throw err
  }
}
