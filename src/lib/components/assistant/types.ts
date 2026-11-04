import type { NucleusTurn } from './nucleus-chat'
import type { ApprovalMode } from '$lib/chat/approvals-client'

export type ApprovalModeState = { status: 'ok'; mode: ApprovalMode } | { status: 'unavailable' }

/** What the assistant panel opens with (GET /api/assistant/conversation). */
export type AssistantConversation = {
  /** The current chat session new turns continue (null until the first turn). */
  sessionId: string | null
  /** The saved transcript of that session, as the panel renders it. */
  turns: NucleusTurn[]
  /** Without a working AI provider the panel says so and links to the setup. */
  providerReady: boolean
  /** Owner/admin decide approval cards and set the approval mode. */
  isAdmin: boolean
  /** Owner/admin only; a failed load is shown as such — never a default mode. */
  approvalMode: ApprovalModeState | null
}

export type AssistantTab = 'chat' | 'history' | 'activity'
