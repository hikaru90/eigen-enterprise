import type { OperationsPort } from '$lib/kernel/operations-tools'
import { roleCan } from '$lib/server/auth/capabilities'
import { getUserRole } from '$lib/server/auth/user-role'
import { withDbUser } from '$lib/server/db'
import { EeClient } from '$lib/server/ee/client'
import { companyStorage } from '$lib/server/company/live'
import { recropCompanyLogo, uploadCompanyLogo } from '$lib/server/company/logo-actions'
import { removeCompanyLogo } from '$lib/server/company/service'

/**
 * The live OperationsPort ($lib/kernel/operations-tools): the same services
 * Settings → Company (logo), Settings → Backups (?/run) and Settings →
 * Updates (?/update) call, each in the acting person's own scope.
 */
export const liveOperationsPort: OperationsPort = {
  can: async (userId, capability) => {
    const role = await getUserRole(userId)
    return capability === 'owner' ? role === 'owner' : roleCan(role, capability)
  },
  setLogo: (userId, input) => withDbUser(userId, () => uploadCompanyLogo(input, userId, companyStorage())),
  recropLogo: (userId, crop) => withDbUser(userId, () => recropCompanyLogo(crop, userId, companyStorage())),
  removeLogo: (userId) => withDbUser(userId, () => removeCompanyLogo(userId, companyStorage())),
  runBackup: async (author) => {
    const { run } = await new EeClient().runBackup({ author })
    return { runId: run.id }
  },
  installRelease: async (release, author) => {
    const { job } = await new EeClient().startUpgrade({ release, author })
    return { jobId: job.id, status: job.status }
  },
}
