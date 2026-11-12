import { appKernel } from '$lib/server/boot'
import type { PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { requireAdmin } from '$lib/server/auth/require-admin'

/**
 * Judge loop surface (phase-2d M2). Owner/admin only; an optional ?session=
 * id hydrates an existing extraction session server-side (a captured site or
 * an uploaded brand guide). Brand is a system module (always on), so there is
 * no activation step.
 */
export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const sessionId = event.url.searchParams.get('session')
  if (!sessionId) return { initial: null }

  const kernel = await appKernel()
  const result = (await kernel.registry.execute(
    'brand.extract_session_get',
    { sessionId },
    {
      principal: { id: user.id, kind: 'human', roles: ['admin'] },
      requestId: randomUUID(),
    },
  )) as {
    session: {
      id: string
      source: 'url' | 'guide'
      url: string | null
      title: string | null
      status: string
    }
    guide: { filename: string; mime: string; sizeBytes: number } | null
    rounds: Array<{
      round: number
      screenshotB64: string
      candidates: Array<{ label: string; cssVars?: Record<string, string>; error?: string }>
      verdict: { chosen: number | null; note?: string } | null
    }>
  }

  const judgedRound = [...result.rounds]
    .reverse()
    .find((r) => r.verdict !== null && r.verdict.chosen !== null)

  return {
    initial: {
      session: result.session,
      guide: result.guide,
      screenshotB64: result.rounds[0]?.screenshotB64 ?? '',
      latestRound: result.rounds[result.rounds.length - 1] ?? null,
      judged: judgedRound
        ? {
            round: judgedRound.round,
            chosen: judgedRound.verdict!.chosen!,
            candidate: judgedRound.candidates[judgedRound.verdict!.chosen!] ?? null,
          }
        : null,
    },
  }
}
