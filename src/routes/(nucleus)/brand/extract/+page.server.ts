import { appKernel } from '$lib/server/boot'
import type { PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { brandModuleState } from '$lib/server/brand/activation'

/**
 * Judge loop surface (phase-2d M2). Owner/admin only; an optional ?session=
 * id hydrates an existing extraction session server-side. Inactive brand
 * module → activation notice flag instead of failing (owner directive:
 * inform BEFORE anything starts).
 */
export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const { active } = await brandModuleState(user)
  if (!active) return { needsModuleActivation: true as const, initial: null }

  const sessionId = event.url.searchParams.get('session')
  if (!sessionId) return { needsModuleActivation: false as const, initial: null }

  const kernel = await appKernel()
  const result = (await kernel.registry.execute(
    'brand.extract_session_get',
    { sessionId },
    {
      principal: { id: user.id, kind: 'human', roles: ['admin'] },
      requestId: randomUUID(),
    },
  )) as {
    session: { id: string; url: string; title: string | null; status: string }
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
    needsModuleActivation: false as const,
    initial: {
      session: result.session,
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
