import { z } from 'zod'
import {
  CHAT_GATEWAY_ALLOWLIST_TOOLS,
  CHAT_GATEWAY_MODULE_ID,
  type AllowlistStore,
} from '$lib/kernel/gateway'
import type { ToolDescriptor } from '$lib/kernel/types'

/**
 * Owner-only allowlist admin surface for the chat-gateway module. Handlers
 * wrap the gateway's AllowlistStore directly — the kernel registry provides
 * permission, audit, and (mutate) vcs commits around them.
 */

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
export function createAllowlistAdminTools(allowlist: AllowlistStore): ToolDescriptor[] {
  const [addName, removeName, listName] = CHAT_GATEWAY_ALLOWLIST_TOOLS
  return [
    {
      name: addName,
      module: CHAT_GATEWAY_MODULE_ID,
      summary: 'Allow one external platform user, mapped to a kernel principal id.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof addInput>) =>
        `Allowed ${PLATFORM_NAME[input.platform]} user ${input.external_user_id} to talk to the company`,
      inputSchema: addInput,
      permission: { roles: ['owner'] },
      handler: async (_ctx, input) => {
        const parsed = addInput.parse(input)
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
