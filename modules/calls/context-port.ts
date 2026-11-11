/**
 * Who may be in a call is decided by the context's owner module, never by
 * Calls (plan/video-calls.md §2). For a DM or a channel that is Messages; the
 * live adapter is wired by the composition root (modules/index.ts), because
 * modules never import each other. A meeting has no owner: its explicit
 * invite list (call_participant rows) is the membership.
 */

export type ConversationKind = 'dm' | 'channel'

export type CallContext = {
  /** "#general", or the DM's people ("Ann Example, Ben Example"). */
  title: string
  /** Everyone who may be in this conversation's call (the actor included). */
  memberIds: string[]
}

export type CallContextPort = {
  /**
   * The conversation as `actorId` may start a call in it (they may post
   * there; archived channels are closed), or null — not found and forbidden
   * look the same (fail closed).
   */
  open(actorId: string, kind: ConversationKind, contextId: string): Promise<CallContext | null>
  /** Whether the person may be in this conversation's call right now. */
  isMember(userId: string, kind: ConversationKind, contextId: string): Promise<boolean>
}
