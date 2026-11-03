import { moduleSource } from '$lib/kernel/cloudevents'
import { emitKernelEvent } from '$lib/kernel/events'
import { dbAccessStore } from './db-store'
import { createAccess, type AccessAudit } from './service'

export * from './types'
export { createAccess, subjectKey, type Access, type AccessDeps, type AccessStore, type ResourceResolver } from './service'

/** Every grant change lands in kernel_events (Overview activity, audit). */
export const kernelAudit: AccessAudit = async ({ type, principalId, payload }) => {
  const { appKernel } = await import('$lib/server/boot')
  const kernel = await appKernel()
  await emitKernelEvent(kernel.eventSink, { type, principalId, source: moduleSource('members'), payload })
}

/** The live access contract (Postgres + kernel audit). Drive and Messages register their resolvers at load. */
export const access = createAccess({ store: dbAccessStore, audit: kernelAudit })

export const canAccess = access.canAccess
export const listGrants = access.listGrants
export const setGrants = access.setGrants
export const registerResourceResolver = access.registerResourceResolver
