import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { backupKeyHandler } from '$lib/server/fleet/backup-key'
import { companyBackupKey, markRecoveryCodePending } from '$lib/server/backups/company-key'

/** Loopback only in practice: ee calls it on OS_INTERNAL_PORT with the per-box token (managed mode). */
export const GET: RequestHandler = ({ request }) =>
  backupKeyHandler({
    token: env.EE_FLEET_LOCAL_TOKEN,
    companyKey: () => companyBackupKey(),
    markPending: () => markRecoveryCodePending(),
  })(request)
