import type { LayoutServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { pluginOffMessage } from '$lib/plugins/routes'
import { userCapabilities } from '$lib/server/auth/require-capability'
import { appKernel } from '$lib/server/boot'
import { speechToTextReadiness } from '$lib/server/llm/speech-readiness'
import { companyIdentity } from '$lib/server/overview/sources'
import { buildShellNav, type ShellData } from '$lib/shell/nav'
import type { UnreadSeed } from '$lib/messages/unread-count.svelte'
import { ASSISTANT_MODULE_ID } from '../../../modules/assistant/manifest'

/**
 * The app shell's data for signed-in pages: the company's name and logo
 * (Settings → Company), what this person may open and do (one capability set
 * from the same rules the route guards use — every menu, tab and card
 * decides from it), the nav (the module registry plus activation state,
 * without pages they can't open) and whether dictation can work (every text
 * box with a mic reads it, so the mic says what is missing instead of failing
 * after a recording). Signed-out visitors get no shell (their pages redirect
 * to /login on their own).
 */
/**
 * Which always-on feeds the shell may open: the call feed (`/api/calls/stream`)
 * needs Calls, the presence beat (`/api/messages/presence`) needs Messages.
 * With the plugin off the gate answers 409, so the shell must not open them.
 */
export type LiveFeeds = { calls: boolean; presence: boolean }

/**
 * The sidebar's Messages counter (wish f397009a): each conversation's unread
 * count and the event id they were read at — the shell's messages stream
 * resumes from it, so nothing committed in between is lost.
 */
async function messagesUnread(userId: string): Promise<UnreadSeed> {
  const { messagesDeps } = await import('../../../modules/messages/live')
  const { listConversations } = await import('../../../modules/messages/service')
  const d = await messagesDeps()
  const cursor = await d.store.latestEventId()
  const conversations = await listConversations(d, userId)
  return { cursor, byConversation: Object.fromEntries(conversations.map((c) => [c.id, c.unread])) }
}

export const load: LayoutServerLoad = async ({
  locals,
}): Promise<{ shell: ShellData | null; liveFeeds?: LiveFeeds; messagesUnread?: UnreadSeed }> => {
  if (!locals.user) return { shell: null }
  // A page of a switched-off plugin (the plugin gate, src/hooks.server.ts): one
  // clear page instead of the plugin's own, which would fail or work regardless.
  if (locals.pluginOff) error(404, { message: pluginOffMessage(locals.pluginOff.name), pluginOff: locals.pluginOff })
  const kernel = await appKernel()
  const [identity, capabilities, activations] = await Promise.all([
    companyIdentity(),
    userCapabilities(locals.user.id),
    kernel.activations.list(),
  ])
  const messagesOn = activations.get('messages') === true
  return {
    ...(messagesOn ? { messagesUnread: await messagesUnread(locals.user.id) } : {}),
    liveFeeds: { calls: activations.get('calls') === true, presence: activations.get('messages') === true },
    shell: {
      companyName: identity.name,
      companyLogo: identity.logo?.url ?? null,
      capabilities,
      nav: buildShellNav(kernel.modules.list(), activations, capabilities),
      assistant: activations.get(ASSISTANT_MODULE_ID) === true,
      dictation: await speechToTextReadiness(locals.user.id),
    },
  }
}
