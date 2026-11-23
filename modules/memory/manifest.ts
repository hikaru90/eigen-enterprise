import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the memory module (single source of truth for the manifest). */
export const MEMORY_TOOL_NAMES = [
  'memory.capture_thought',
  'memory.retrieve_thoughts',
  'memory.list_projects',
  'memory.get_project_timeline',
  'memory.list_text_files',
  'memory.get_text_file',
  'memory.search_text_files',
  'memory.create_text_file',
  'memory.update_text_file',
  'memory.set_project_visibility',
  'memory.set_text_file_visibility',
] as const

/** Memory is a system module (always on): see SYSTEM_MODULE_IDS. */
export const MEMORY_MODULE_ID = 'memory'

/** Thoughts, entities, the graph, notes-on-thoughts and connected agents (thought-tools.ts). */
export const THOUGHT_TOOL_NAMES = [
  'memory.edit_thought',
  'memory.set_thought_status',
  'memory.delete_thought',
  'memory.delete_archived_thoughts',
  'memory.retry_enrichment',
  'memory.relink_thought',
  'memory.answer_check_in',
  'memory.assign_thought_project',
  'memory.get_thought',
  'memory.list_archived_thoughts',
  'memory.list_thought_notes',
  'memory.link_text_file',
  'memory.unlink_text_file',
  'memory.delete_text_file',
  'memory.get_entity',
  'memory.update_entity',
  'memory.delete_entity',
  'memory.sync_entity',
  'memory.clean_up_graph',
  'memory.list_connected_agents',
  'memory.list_agent_projects',
  'memory.assign_thought_to_agent',
  'memory.bind_agent_project',
  'memory.unbind_agent_project',
] as const

/** The person's own Memory › Tasks (own-task-tools.ts): list, add, change, complete, delete. */
export const OWN_TASK_TOOL_NAMES = [
  'memory.list_tasks',
  'memory.create_task',
  'memory.update_task',
  'memory.complete_task',
  'memory.delete_task',
] as const

/** Tasks assigned between members (task-tools.ts): the `tasks` namespace belongs to Memory. */
export const TASK_TOOL_NAMES = ['tasks.assignees', 'tasks.assign', 'tasks.list', 'tasks.complete', 'tasks.comment'] as const

/** A person's own recurring reminders (reminder-tools.ts): the `reminders` namespace belongs to Memory. */
export const REMINDER_TOOL_NAMES = [
  'reminders.create',
  'reminders.list',
  'reminders.update',
  'reminders.pause',
  'reminders.resume',
  'reminders.delete',
  'reminders.complete',
  'reminders.snooze',
] as const

/** Projects, scheduled tasks, timeline items, assigned-task "seen" (project-schedule-tools.ts). */
export const PROJECT_SCHEDULE_TOOL_NAMES = [
  'memory.create_project',
  'memory.rename_project',
  'memory.set_project_deadline',
  'memory.set_project_milestone',
  'memory.dismiss_project',
  'memory.order_project_task',
  'memory.apply_project_review',
  'memory.list_scheduled_tasks',
  'memory.pause_scheduled_task',
  'memory.resume_scheduled_task',
  'memory.run_scheduled_task',
  'memory.stop_scheduled_task',
  'memory.retry_scheduled_task_step',
  'memory.reschedule_timeline_item',
  'memory.snooze_timeline_item',
  'memory.set_timeline_item_status',
  'tasks.mark_seen',
] as const

export const memoryManifest: ModuleManifest = {
  id: MEMORY_MODULE_ID,
  name: 'Memory',
  version: '0.1.0',
  description:
    'Thought capture, hybrid retrieval, and GTD project/text-note tools over the eigen memory system.',
  toolNamespaces: [MEMORY_MODULE_ID, 'tasks', 'reminders'],
  tools: [...MEMORY_TOOL_NAMES, ...THOUGHT_TOOL_NAMES, ...OWN_TASK_TOOL_NAMES, ...TASK_TOOL_NAMES, ...REMINDER_TOOL_NAMES, ...PROJECT_SCHEDULE_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
