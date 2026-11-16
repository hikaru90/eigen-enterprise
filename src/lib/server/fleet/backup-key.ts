import type { BackupKeyMaterial } from '$lib/server/backups/company-key'
import { fleetAuthorized } from './seats'

/**
 * The backup key for a managed box (plan/phase-managed-box.md): when the
 * control plane sets a backup target and ee has no sealed key yet, ee asks os
 * on loopback with EE_FLEET_LOCAL_TOKEN. Only the derived backup key leaves —
 * never the root key or the recovery code — and it is never logged. When this
 * call created the company root key, the recovery code is marked pending so
 * the owner sees it once in Settings › Backups.
 */
export function backupKeyHandler(deps: {
  token: string | undefined
  companyKey: () => Promise<BackupKeyMaterial>
  markPending: () => Promise<void>
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const denied = fleetAuthorized(deps.token, request)
    if (denied) return denied
    const key = await deps.companyKey()
    if (key.created) await deps.markPending()
    return Response.json({ backupKey: key.backupKey })
  }
}
