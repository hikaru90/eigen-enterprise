import { DECISION_KINDS } from '../../../../modules/decision-kinds'
import { decisionsPort } from './service'
import { liveDecisionStore } from './store'

/** The decisions.* tools' live port: the decision log in Postgres and the declared kinds. */
export const liveDecisionsPort = decisionsPort(liveDecisionStore, DECISION_KINDS)

/** A person's open decision questions (the dashboard's Needs you reads them like decisions.questions). */
export const needsYouDecisionQuestions = (userId: string) => liveDecisionsPort.questions(userId)
