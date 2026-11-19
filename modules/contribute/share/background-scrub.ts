import type { JudgeChat } from '../judge'
import type { ScrubResult } from './scrub'
import { scrubTitle } from './scrub'

/**
 * The scrub as the sharing worker runs it: on the job-queue tick, outside any
 * request, so there is no app DB context. The gateway reads the provider config
 * and records cost through getDb(), so the call runs inside a DB context scoped
 * to the owner (whose account holds the company's AI provider), on the company
 * provider, attributed to the owner.
 */
export type BackgroundScrubDeps = {
  ownerId: () => Promise<string | null>
  onCompanyProvider: <T>(fn: () => Promise<T>) => Promise<T>
  withDbUser: <T>(userId: string, fn: () => Promise<T>) => Promise<T>
  chat: JudgeChat
}

export async function backgroundScrub(title: string, d: BackgroundScrubDeps): Promise<ScrubResult> {
  const owner = await d.ownerId()
  if (!owner) throw new Error('the company has no owner')
  return d.withDbUser(owner, () => d.onCompanyProvider(() => scrubTitle(d.chat, { userId: owner, title })))
}
