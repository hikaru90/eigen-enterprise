import { decisionKindCatalog } from '$lib/server/decisions/kind'
import { coworkerEventMine } from './coworkers/decision-kinds'
import { memoryHandoverStatus } from './memory/decision-kinds'
import { websitePageAudience } from './website/decision-kinds'

/**
 * Every declared decision kind (plan/phase-company-brain.md §5, CB2). A module declares its
 * kinds next to its code (`modules/<id>/decision-kinds.ts`, defineDecisionKind) and lists them
 * here — the composition root, like modules/index.ts, so no module imports another. The
 * catalog fails at load when two kinds share an id. decisions.kinds reads it; a question in
 * Needs you is answered from its kind's closed set.
 */
export const DECISION_KINDS = decisionKindCatalog([websitePageAudience, coworkerEventMine, memoryHandoverStatus])
