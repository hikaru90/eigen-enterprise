/**
 * Every event type the core emits (core-api 1.x, plan/phase-upgrades.md R2):
 * the event half of the contract a module may depend on. `emitKernelEvent`
 * accepts only these types (by type and at runtime), so a new emit site
 * cannot ship an event the contract does not know, and
 * `contracts/core-api.lock.json` snapshots this list.
 *
 * `module` is the emitter (a module id, or `kernel`). `payload` is the event's
 * payload JSON Schema; no event declares one yet, so each records `null`
 * explicitly and the lock says so.
 */
export type CoreEventDefinition = {
  module: string
  payload: null
}

export const CORE_EVENTS = {
  // The kernel: tool calls, approvals, the agent runtime and the harness.
  'agent.budget_exceeded': { module: 'kernel', payload: null },
  'agent.dispatched': { module: 'kernel', payload: null },
  'agent.replied': { module: 'kernel', payload: null },
  'agent.stopped': { module: 'kernel', payload: null },
  'agent.turn_superseded': { module: 'kernel', payload: null },
  'approval.auto_approved': { module: 'kernel', payload: null },
  'approval.mode_changed': { module: 'kernel', payload: null },
  'harness.turn_failed': { module: 'kernel', payload: null },
  'tool.executed': { module: 'kernel', payload: null },
  // The orchestrator: journeys and the agent's repo hands.
  'journey.abandoned': { module: 'orchestrator', payload: null },
  'journey.completed': { module: 'orchestrator', payload: null },
  'repo.command_run': { module: 'orchestrator', payload: null },
  'repo.file_written': { module: 'orchestrator', payload: null },
  'repo.merged': { module: 'orchestrator', payload: null },
  'repo.verify_failed': { module: 'orchestrator', payload: null },
  'repo.worktree_created': { module: 'orchestrator', payload: null },
  // Backups.
  'backup.alert': { module: 'backups', payload: null },
  'backup.run_failed': { module: 'backups', payload: null },
  'backup.run_succeeded': { module: 'backups', payload: null },
  // Members: access grants, groups, open join.
  'access.grants_set': { module: 'members', payload: null },
  'members.group_created': { module: 'members', payload: null },
  'members.group_deleted': { module: 'members', payload: null },
  'members.group_updated': { module: 'members', payload: null },
  'members.open_join_changed': { module: 'members', payload: null },
  // Calendar.
  'calendar.default_visibility_set': { module: 'calendar', payload: null },
  'calendar.event_created': { module: 'calendar', payload: null },
  'calendar.event_deleted': { module: 'calendar', payload: null },
  'calendar.event_updated': { module: 'calendar', payload: null },
  'calendar.proposal_accepted': { module: 'calendar', payload: null },
  'calendar.proposal_dismissed': { module: 'calendar', payload: null },
  'calendar.proposal_filed': { module: 'calendar', payload: null },
  'calendar.week_numbers_set': { module: 'calendar', payload: null },
  // Chat gateway (Telegram).
  'gateway.telegram.denied': { module: 'chat-gateway', payload: null },
  'gateway.telegram.message': { module: 'chat-gateway', payload: null },
  // Contacts.
  'contacts.contact_logged': { module: 'contacts', payload: null },
  'contacts.created': { module: 'contacts', payload: null },
  'contacts.default_visibility_set': { module: 'contacts', payload: null },
  'contacts.deleted': { module: 'contacts', payload: null },
  'contacts.imported': { module: 'contacts', payload: null },
  'contacts.sharing_changed': { module: 'contacts', payload: null },
  'contacts.updated': { module: 'contacts', payload: null },
  // Contribute.
  'contribute.proposed': { module: 'contribute', payload: null },
  'contribute.status_changed': { module: 'contribute', payload: null },
  // Email (the inbox's mailboxes).
  'email.mailbox_alias_added': { module: 'email', payload: null },
  'email.mailbox_alias_removed': { module: 'email', payload: null },
  'email.mailbox_assigned': { module: 'email', payload: null },
  'email.mailbox_disabled': { module: 'email', payload: null },
  'email.mailbox_enabled': { module: 'email', payload: null },
  // Messages.
  'messages.message_moderated': { module: 'messages', payload: null },
  // Recap, repos, website.
  'recap.completed': { module: 'recap', payload: null },
  'repos.synced': { module: 'repos', payload: null },
  'website.contact.captured': { module: 'website', payload: null },
} as const satisfies Record<string, CoreEventDefinition>

export type CoreEventType = keyof typeof CORE_EVENTS

export function isCoreEventType(type: string): type is CoreEventType {
  return Object.hasOwn(CORE_EVENTS, type)
}
