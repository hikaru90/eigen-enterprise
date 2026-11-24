import type { AccountableHuman, CoworkerDeps, CoworkerView } from './service'
import { avatarBlobs } from '$lib/server/profile/avatar'
import { dbCoworkerStore } from './db-store'
import * as service from './service'

/**
 * The live co-workers wiring (plan/phase-ai-coworkers.md). The functions C3 (the
 * co-worker turn), C4 (memory) and C5 (UI) consume:
 *
 * - listEnabledCoworkers(): the co-workers that work right now (runtime registration).
 * - accountableHumanFor(id) / accountableHumansFor(id): the person(s) a co-worker answers to (approvals, "Needs you").
 * - getCoworker(id) / listCoworkers(): role cards (title, accountabilities, lens, model, cap).
 * - orgChart(): everyone's seat, people and co-workers.
 * - coworkerAgentId(id) + coworkerPrincipal (kernel/principals.ts): who a co-worker's calls run as.
 */
export * from './service'
export { COWORKER_TEMPLATES, COWORKER_TEMPLATE_IDS, coworkerTemplate, type CoworkerTemplate, type CoworkerTemplateId } from './templates'

export function coworkerDeps(): CoworkerDeps {
  return {
    store: dbCoworkerStore,
    avatarExists: (sha256) => avatarBlobs().has(sha256),
  }
}

export function listEnabledCoworkers(): Promise<CoworkerView[]> {
  return service.listEnabledCoworkers(dbCoworkerStore)
}

export function listCoworkers(): Promise<CoworkerView[]> {
  return service.listCoworkers(dbCoworkerStore)
}

export function getCoworker(userId: string): Promise<CoworkerView> {
  return service.getCoworker(dbCoworkerStore, userId)
}

export function accountableHumanFor(coworkerUserId: string): Promise<AccountableHuman> {
  return service.accountableHumanFor(dbCoworkerStore, coworkerUserId)
}

export function accountableHumansFor(coworkerUserId: string): Promise<AccountableHuman[]> {
  return service.accountableHumansFor(dbCoworkerStore, coworkerUserId)
}

export function orgChart(): ReturnType<typeof service.orgChart> {
  return service.orgChart(dbCoworkerStore)
}
