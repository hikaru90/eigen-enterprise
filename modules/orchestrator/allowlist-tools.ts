import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import {
  CHAT_GATEWAY_ALLOWLIST_TOOLS,
  CHAT_GATEWAY_MODULE_ID,
  type AllowlistStore,
} from '$lib/kernel/gateway'
import type { PersonRef } from '$lib/kernel/principals'
import type { ToolDescriptor } from '$lib/kernel/types'

/**
 * Owner-only allowlist admin surface for the chat-gateway module. Handlers
 * wrap the gateway's AllowlistStore directly — the kernel registry provides
 * permission, audit, and (mutate) vcs commits around them.
 *
 * An entry LINKS a Telegram user to a member (CB3): the company brain answers
 * that sender as the member, so `principal_id` must be a current member's id —
 * a link to anything else is refused here, and the gateway refuses at message
 * time anyone whose link no longer names a member.
 */

/** Who a link may name: a current member (the brain's person lookup). */
export type AllowlistMembers = {
  personFor(memberId: string): Promise<PersonRef | null>
}

const platformSchema = z.enum(['telegram'])

const addInput = z.object({
  platform: platformSchema,
  external_user_id: z.string().min(1),
  principal_id: z.string().min(1),
})

/** Declared display names per platform (the enum above is the full set). */
const PLATFORM_NAME: Record<z.infer<typeof platformSchema>, string> = { telegram: 'Telegram' }

const removeInput = z.object({
  platform: platformSchema,
  external_user_id: z.string().min(1),
})

/** Kernel descriptors for the three allowlist admin tools (see CHAT_GATEWAY_ALLOWLIST_TOOLS). */
export function createAllowlistAdminTools(allowlist: AllowlistStore, members: AllowlistMembers): ToolDescriptor[] {
  const [addName, removeName, listName] = CHAT_GATEWAY_ALLOWLIST_TOOLS
  return [
    {
      name: addName,
      module: CHAT_GATEWAY_MODULE_ID,
      summary:
        'Link one external platform user (e.g. a Telegram user id) to a member of the company: the company brain answers them as that member. principal_id is the member id; anything else is refused.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof addInput>) =>
        `Allowed ${PLATFORM_NAME[input.platform]} user ${input.external_user_id} to talk to the company`,
      inputSchema: addInput,
      permission: { roles: ['owner'] },
      handler: async (_ctx, input) => {
        const parsed = addInput.parse(input)
        if (!(await members.personFor(parsed.principal_id))) {
          throw new KernelError(
            'invalid_input',
            `principal_id ${parsed.principal_id} is not a member of this company: a ${PLATFORM_NAME[parsed.platform]} user can only be linked to a member`,
          )
        }
        await allowlist.add(parsed.platform, parsed.external_user_id, parsed.principal_id)
        return { ok: true, platform: parsed.platform, external_user_id: parsed.external_user_id }
      },
    },
    {
      name: removeName,
      module: CHAT_GATEWAY_MODULE_ID,
      summary: 'Remove one external platform user from the allowlist.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof removeInput>) =>
        `Removed ${PLATFORM_NAME[input.platform]} user ${input.external_user_id} from the allowed list`,
      inputSchema: removeInput,
      permission: { roles: ['owner'] },
      handler: async (_ctx, input) => {
        const parsed = removeInput.parse(input)
        await allowlist.remove(parsed.platform, parsed.external_user_id)
        return { ok: true, platform: parsed.platform, external_user_id: parsed.external_user_id }
      },
    },
    {
      name: listName,
      module: CHAT_GATEWAY_MODULE_ID,
      summary: 'List all allowlisted external platform users with their principal mapping.',
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: { roles: ['owner'] },
      handler: async () => allowlist.list(),
    },
  ]
}
