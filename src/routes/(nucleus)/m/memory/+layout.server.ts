import type { LayoutServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { appKernel } from '$lib/server/boot'
import { env } from '$lib/server/env/private-env'
import { MEMORY_MODULE_ID } from '../../../../../modules/memory/manifest'

/**
 * The Memory module page (phase-cohesion §3): one page with Overview, Tasks,
 * Projects, Notes and Capture as sub-pages. Memory is a system module, so its
 * status comes from the same activation the kernel gates its tools on — the
 * header can never say "Not active" while the tools work.
 */
export const load: LayoutServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const kernel = await appKernel()
  const manifest = kernel.modules.get(MEMORY_MODULE_ID)
  if (!manifest) throw error(404, 'No such module')
  const active = (await kernel.activations.get(MEMORY_MODULE_ID)) === true
  return {
    memory: { name: manifest.name, description: manifest.description ?? '', active },
    // The gateway sends every AI request's input/output to PostHog when its key is set
    // (llm-client.ts $ai_generation): the "Who can see your Memory" note says so.
    privacy: { analyticsSeesAi: Boolean(env.POSTHOG_API_KEY?.trim()) },
  }
}
