import type { OperationsPort } from '$lib/kernel/operations-tools'
import { roleCan } from '$lib/server/auth/capabilities'
import { getUserRole } from '$lib/server/auth/user-role'
import { withDbUser } from '$lib/server/db'
import { EeClient, SubstrateError, SubstrateUnavailableError } from '$lib/server/ee/client'
import { companyStorage } from '$lib/server/company/live'
import { recropCompanyLogo, uploadCompanyLogo } from '$lib/server/company/logo-actions'
import { removeCompanyLogo } from '$lib/server/company/service'

/**
 * The live OperationsPort ($lib/kernel/operations-tools): the same services
 * Settings → Company (logo), Settings → Backups (?/run) and Settings →
 * Updates (?/update) call, each in the acting person's own scope.
 */
/** The release a tarball belongs to, as ee's releaseOf (ee/src/upgrade.ts); null for a name of another shape. */
const RELEASE_TARBALL = /^(eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12})-linux-(?:x64|arm64)\.tar\.gz$/
function releaseName(tarball: string): string | null {
  return RELEASE_TARBALL.exec(tarball)?.[1] ?? null
}

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
  releaseStatus: async () => {
    const client = new EeClient()
    const info = await client.upgrade()
    const installed = info.installed ? { release: releaseName(info.installed.tarball), tarball: info.installed.tarball, version: info.installed.version } : null
    const job = info.job
      ? { id: info.job.id, release: info.job.release, status: info.job.status, step: info.job.step, error: info.job.error, endedAt: info.job.endedAt }
      : null
    // As Settings → Updates: nothing to look up while an update runs, or on a box its hosting provider updates.
    if (info.managed || info.job?.status === 'running') return { installed, managed: info.managed, latest: null, latestError: null, job }
    try {
      const { latest } = await client.latestRelease()
      return { installed, managed: false, latest: { release: latest.name, version: latest.version, state: latest.state, notes: latest.notes }, latestError: null, job }
    } catch (err) {
      if (err instanceof SubstrateError || err instanceof SubstrateUnavailableError)
        return { installed, managed: false, latest: null, latestError: err.message, job }
      throw err
    }
  },
  installRelease: async (release, author) => {
    const { job } = await new EeClient().startUpgrade({ release, author })
    return { jobId: job.id, status: job.status }
  },
}
