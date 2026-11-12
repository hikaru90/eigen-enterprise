import { approvalModeFromResponse } from '$lib/chat/approvals-client'
import {
  nucleusTurnsFromPersisted,
  persistedApprovalIds,
} from '$lib/components/assistant/nucleus-chat'
import type { ApprovalModeState, AssistantConversation } from '$lib/components/assistant/types'
import { getUserRole, isAdminRole } from '$lib/server/auth/user-role'
import {
  loadApprovalStatuses,
  loadCurrentConversation,
  loadPendingApprovalsByTool,
} from '$lib/server/chat/current-conversation'
import { getDb } from '$lib/server/db'
import { isCompanyProviderReady } from '$lib/server/llm/provider-ready'

/**
 * The company agent's current conversation for one member (polish P-1: the
 * chat moved from `/` into the shell's assistant panel). The chat survives
 * navigation: the session and its stored turns come from Postgres
 * (chat_message), approval cards carry their current kernel status.
 */
export async function loadAssistantConversation(
  userId: string,
  fetch: typeof globalThis.fetch,
): Promise<AssistantConversation> {
  const isAdmin = isAdminRole(await getUserRole(userId))
  const conversation = await loadCurrentConversation(getDb(), userId)
  const approvalStatuses = await loadApprovalStatuses(
    getDb(),
    persistedApprovalIds(conversation.messages),
  )

  let approvalMode: ApprovalModeState | null = null
  if (isAdmin) {
    const res = await fetch('/api/approvals/mode')
    const mode = res.ok ? approvalModeFromResponse(await res.json()) : null
    if (!mode) console.error('[assistant] approval mode load failed', { status: res.status })
    approvalMode = mode ? { status: 'ok', mode } : { status: 'unavailable' }
  }

  return {
    sessionId: conversation.sessionId,
    turns: nucleusTurnsFromPersisted(
      conversation.messages,
      approvalStatuses,
      await loadPendingApprovalsByTool(getDb()),
    ),
    providerReady: await isCompanyProviderReady(),
    isAdmin,
    approvalMode,
  }
}
