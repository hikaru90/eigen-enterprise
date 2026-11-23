import type { TableRule } from './plan'

/**
 * The company export's rule for every table (plan/phase-export.md §2, §6).
 *
 * The line between company data and a member's private data is the app's own
 * (owner decision 2026-11-23, "everything the company owns, including private
 * data as metadata"): **what the app shows the owner is exported in full; what
 * the app hides from the owner is exported as metadata only** — and work is the
 * company's (owner, 2026-11-23: "what we sell is the company being able to export
 * the decisions made by an employee … exclude things marked as private, just
 * include metadata"). So contacts, Drive, private channels, shared mailboxes,
 * company-visible calendar events and assigned tasks are full; what is marked
 * private or is private by kind (DMs and their attachments, personal mailboxes,
 * private Memory, busy/private calendar events, unshared call answers, DM calls)
 * and a member's own spaces (assistant chats, reminders, settings) are metadata. Metadata is what a camera could
 * observe: whose, when, how big, with whom (by member id). Names, titles,
 * bodies, addresses and embeddings are content.
 *
 * A new table fails the export (and plan-rules.pg.spec.ts) until it is classified here.
 */

const full: TableRule = { export: 'full' }
const fullWith = (...secret: string[]): TableRule => ({ export: 'full', secret })
const excluded = (reason: string): TableRule => ({ export: 'excluded', reason })
const meta = (privateWhen: string, metaCols: string[], content: string[], secret: string[] = []): TableRule => ({
  export: 'private-as-meta',
  privateWhen,
  meta: metaCols,
  content,
  secret,
})

// --- predicates (SQL over the row `t`) ---------------------------------------

/** A Memory project every member can read (enable_rls.sql: canonical_entity company read). */
const companyProject = (a: string) =>
  `(${a}.visibility = 'company' AND ${a}.project_status IS NOT NULL AND ${a}.project_status <> 'dismissed')`
const isCompanyProject = (idExpr: string) =>
  `EXISTS (SELECT 1 FROM canonical_entity ce WHERE ce.id = ${idExpr} AND ${companyProject('ce')})`
/** A task thought on a company project (enable_rls.sql: thought_shared_read). */
const isSharedTask = (thoughtIdExpr: string) =>
  `EXISTS (SELECT 1 FROM thought th JOIN thought_entity te ON te.thought_id = th.id AND te.user_id = th.user_id ` +
  `JOIN canonical_entity ce ON ce.id = te.entity_id AND ce.user_id = th.user_id ` +
  `WHERE th.id = ${thoughtIdExpr} AND th.category = 'task' AND ${companyProject('ce')})`
/** An AI co-worker's thought: readable by every member (enable_rls.sql: thought_coworker_read, 0171). */
const isCoworkerThought = (thoughtIdExpr: string) =>
  `EXISTS (SELECT 1 FROM thought th JOIN "user" cw ON cw.id = th.user_id WHERE th.id = ${thoughtIdExpr} AND cw.kind = 'coworker')`
const inDm = (conversationIdExpr: string) =>
  `EXISTS (SELECT 1 FROM message_conversations c WHERE c.id = ${conversationIdExpr} AND c.kind = 'dm')`
const dmMessage = (messageIdExpr: string) =>
  `EXISTS (SELECT 1 FROM messages m JOIN message_conversations c ON c.id = m.conversation_id WHERE m.id = ${messageIdExpr} AND c.kind = 'dm')`
/** A Drive file attached to a DM (Messages hides DMs from the owner; its attachments follow). */
export const DM_FILE = (fileIdExpr: string) =>
  `EXISTS (SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma.message_id ` +
  `JOIN message_conversations c ON c.id = m.conversation_id WHERE ma.file_id = ${fileIdExpr} AND c.kind = 'dm')`
const personalMailbox = (mailboxIdExpr: string) =>
  `EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.id = ${mailboxIdExpr} AND mb.kind = 'personal')`
const personalMail = (messageIdExpr: string) =>
  `EXISTS (SELECT 1 FROM inbox_messages im JOIN mailboxes mb ON mb.id = im.mailbox_id WHERE im.id = ${messageIdExpr} AND mb.kind = 'personal')`
const dmCall = (callIdExpr: string) => `EXISTS (SELECT 1 FROM call cl WHERE cl.id = ${callIdExpr} AND cl.context_kind = 'dm')`
const always = 'true'

const AUTHOR = ['author', 'author_label', 'author_key_id']

export const COMPANY_EXPORT_RULES: Record<string, TableRule> = {
  // --- people, sign-in, team -------------------------------------------------
  user: full,
  account: fullWith('access_token', 'refresh_token', 'id_token', 'password'),
  passkey: fullWith('public_key', 'credential_id', 'counter'),
  session: excluded('sign-in sessions; they only work on this server'),
  verification: excluded('one-time sign-in codes; they expire in minutes'),
  member_invite: fullWith('token_hash'),
  member_open_join: full,
  company_join: full,
  claim_consumed: excluded('used one-time claim links (hashes only)'),
  member_group: full,
  member_group_member: full,
  // The org chart and the AI co-workers (0170, plan/phase-ai-coworkers.md): every member sees
  // them in the app (titles, accountabilities, reports-to, role cards, run log), so all in full.
  org_position: full,
  coworker_profile: full,
  coworker_run: full,
  // C6 (0173): a co-worker's rhythms (schedule, instruction, target conversation) and the
  // "Needs you" notices of its proactive runs: company-level, shown in the app, all in full.
  coworker_rhythm: full,
  coworker_run_notice: full,
  access_grant: full,
  user_api_key: fullWith('key_hash'),
  push_subscription: excluded('device push endpoints; each device subscribes again on the new system'),
  tenant_data_key: excluded('encryption keys wrapped by this server’s master key; useless anywhere else'),
  company_data_key: excluded('encryption keys wrapped by this server’s master key; useless anywhere else'),
  user_preference: meta(
    always,
    ['user_id', 'updated_at', 'welcome_completed_at'],
    [
      'preferred_language', 'preferred_transcription_quality', 'billing_mode', 'default_billing_currency',
      'preferred_ui_locale', 'preferred_timezone', 'event_notifications_enabled', 'event_reminder_lead_minutes',
      'event_reminder_kinds', 'daily_work_minutes', 'daily_summary_enabled', 'daily_summary_minutes_local',
      'last_daily_summary_local_date', 'preferred_timezone_offset_minutes', 'last_daily_summary_dispatch_error',
      'display_name', 'dashboard_hidden_tiles',
    ],
  ),

  // --- company ---------------------------------------------------------------
  company_profile: full,
  company_ai: full,
  company_export: full,
  kernel_principals: fullWith('api_key_hash'),
  kernel_events: full,
  kernel_approvals: full,
  kernel_approval_mode: full,
  kernel_module_activations: full,
  kernel_journeys: full,
  kernel_gateway_allowlist: full,
  kernel_gateway_sessions: excluded('live chat-gateway sessions; they reconnect'),
  gitstore_watermark: full,
  'drizzle.__drizzle_migrations': full,

  // --- AI, billing -----------------------------------------------------------
  llm_provider_config: fullWith('api_key', 'api_key_encrypted', 'oauth_access_encrypted', 'oauth_refresh_encrypted'),
  llm_active_provider: full,
  activity_call_log: meta(
    always,
    ['id', 'user_id', 'provider', 'operation', 'base_cost_usd', 'markup_usd', 'total_cost_usd', 'markup_rate', 'created_at', 'group_id', 'duration_ms', 'gateway_host'],
    ['context'],
  ),
  user_wallet: full,
  wallet_ledger_entry: full,
  payment_order: full,

  // --- Memory (private to its member unless on a company project or an AI co-worker's) ---
  thought: meta(
    `NOT ${isSharedTask('t.id')} AND NOT ${isCoworkerThought('t.id')}`,
    [
      'id', 'user_id', 'category', 'created_at', 'updated_at', 'ontology_entity_kind_id', 'salience_score',
      'access_count', 'last_accessed_at', 'enriched_at', 'enrichment_version', 'primary_community_ids',
      'entity_centrality_max', 'specificity_score', 'recency_bucket', 'bundle_rank', 'enrich_queue_status',
      'capture_source', ...AUTHOR, 'lifecycle_status', 'lifecycle_updated_at', 'lifecycle_completed_at',
      'task_kind', 'task_started_at', 'task_position',
    ],
    [
      'raw_text', 'normalized_text', 'lexical_text', 'lexical_tsv', 'metadata', 'embedding', 'cues',
      'raw_text_encrypted', 'normalized_text_encrypted', 'metadata_encrypted', 'cues_encrypted',
      'rerank_snippet', 'enrich_queue_error',
    ],
  ),
  capture_session: meta(
    always,
    ['id', 'user_id', 'status', 'category', 'revision_count', 'created_at', 'updated_at', ...AUTHOR, 'thought_id'],
    ['raw_input', 'normalized_preview', 'metadata_preview', 'raw_input_encrypted', 'normalized_preview_encrypted'],
  ),
  canonical_entity: meta(
    `NOT ${companyProject('t')}`,
    [
      'id', 'user_id', 'entity_type', 'created_at', 'updated_at', ...AUTHOR, 'project_status', 'project_source',
      'next_action_thought_id', 'project_designated_at', 'target_date', 'system_key', 'visibility',
    ],
    ['canonical_key', 'label', 'embedding'],
  ),
  entity_alias: meta(`NOT ${isCompanyProject('t.canonical_entity_id')}`, ['id', 'user_id', 'canonical_entity_id', 'created_at'], ['alias_text']),
  thought_entity: full,
  thought_relation: full,
  thought_text_file: full,
  text_file: meta(
    `t.visibility = 'private'`,
    ['id', 'user_id', 'created_at', 'updated_at', ...AUTHOR, 'visibility'],
    ['title', 'body_text', 'body_text_encrypted', 'lexical_text', 'lexical_tsv'],
  ),
  temporal_event: meta(
    `NOT ${isSharedTask('t.thought_id')} AND NOT ${isCoworkerThought('t.thought_id')}`,
    [
      'id', 'user_id', 'thought_id', 'graph_node_id', 'kind', 'active_period', 'time_precision', 'timezone',
      'is_all_day', 'recurrence_rule', 'confidence', 'start_at', 'end_at', 'graph_sync_status', 'created_at',
      'updated_at', 'lifecycle_status', 'lifecycle_updated_at', 'snoozed_until', 'duration_minutes',
      'energy_level', 'priority_quadrant', 'parent_event_id', 'focus_rank', ...AUTHOR,
    ],
    ['semantic_summary', 'embedding', 'lexical_text', 'lexical_tsv', 'source_text_span', 'parse_metadata', 'context_tags', 'graph_sync_error'],
  ),
  project_task_sequence: full,
  project_milestone: meta(
    `NOT ${isCompanyProject('t.project_entity_id')}`,
    ['id', 'project_entity_id', 'user_id', 'target_date', 'rank', 'completed_at', 'linked_thought_id', 'linked_temporal_event_id', 'created_at', 'updated_at'],
    ['label'],
  ),
  ontology_entity_kind: meta(
    always,
    ['id', 'user_id', 'key', 'active', 'created_at', 'updated_at', 'kind_type', 'never_stale'],
    ['name', 'definition'],
  ),
  ontology_relation_kind: meta(
    always,
    ['id', 'user_id', 'key', 'from_ontology_entity_kind_id', 'to_ontology_entity_kind_id', 'active', 'created_at', 'updated_at'],
    ['meaning'],
  ),
  ontology_proposal: meta(
    always,
    ['id', 'user_id', 'key', 'evidence_count', 'frequency_score', 'status', 'created_at', 'updated_at'],
    ['name', 'definition'],
  ),
  user_grounding_profile: meta(
    always,
    ['user_id', 'initial_completed_at', 'last_session_at', 'session_count', 'updated_at', 'last_grounding_push_at'],
    ['narrative_summary_encrypted', 'facets', 'pending_check_in'],
  ),
  chat_session: meta(always, ['id', 'user_id', 'created_at', 'updated_at', 'mode'], ['title']),
  chat_message: meta(always, ['id', 'session_id', 'user_id', 'role', 'created_at', 'durable_answer_key'], ['content', 'metadata']),
  feedback: meta(always, ['id', 'user_id', 'created_at'], ['message']),
  reminders: meta(
    always,
    ['id', 'user_id', 'weekdays', 'time_of_day', 'time_zone', 'status', 'handled_through', 'snoozed_until', 'created_via', 'created_at', 'updated_at'],
    ['title', 'note'],
  ),
  user_scheduled_task: full,
  event_reminder_schedule: full,
  agent_project_binding: full,
  agent_task_assignment: meta(
    always,
    ['id', 'user_id', 'agent_id', 'thought_id', 'status', 'assigned_at', 'started_at', 'completed_at', 'result_thought_id'],
    ['result_summary', 'last_error'],
  ),
  connected_agent: meta(
    always,
    ['id', 'user_id', 'subscribed_events', 'signing_secret_prefix', 'callback_token_prefix', 'enabled', 'last_delivery_at', 'created_at', 'updated_at', 'signature_mode'],
    ['name', 'webhook_url'],
    ['signing_secret_encrypted', 'callback_token_hash'],
  ),
  webhook_delivery: meta(
    always,
    ['id', 'user_id', 'agent_id', 'event_type', 'event_id', 'status', 'attempt_count', 'http_status', 'delivered_at', 'created_at'],
    ['payload', 'last_error'],
  ),
  durable_conversations: meta(
    always,
    ['id', 'conversation_key', 'agent_id', 'llm_user_id', 'pi_conversation_id', 'provider_session_id', 'created_at', 'updated_at', 'run_principal_id', 'run_tools'],
    ['user_title'],
  ),
  // Derived from the Memory tables above (rebuilt from them), or run logs.
  thought_neighbor: excluded('derived from Memory (nearest neighbours); rebuilt from thought'),
  entity_top_thoughts: excluded('derived from Memory (ranking cache)'),
  entity_resolution_log: excluded('derived from Memory (how mentions were matched)'),
  user_ontology: excluded('derived from Memory (a member’s inferred profile)'),
  graph_community: excluded('derived from Memory (graph clustering)'),
  community_member: excluded('derived from Memory (graph clustering)'),
  community_bundle: excluded('derived from Memory (graph clustering)'),
  community_summary: excluded('derived from Memory (graph clustering)'),
  graph_sync_job: excluded('background queue that keeps the Memory graph in step'),
  retrieval_quality_event: excluded('search quality telemetry'),
  heartbeat_run: excluded('background run log'),
  consolidation_run: excluded('background run log'),
  user_job_queue: excluded('background work queue (in-flight jobs)'),
  contact_next_up: excluded('derived: a member’s daily AI suggestions, made again each day'),
  eval_run: excluded('test harness data'),
  eval_entry: excluded('test harness data'),
  eval_event: excluded('test harness data'),
  eval_thought_map: excluded('test harness data'),
  eval_qa: excluded('test harness data'),

  // --- Contacts (the owner and admins see every contact) -------------------
  contacts: full,
  contact_log_entries: full,
  contact_shares: full,
  contact_preferences: full,
  contact_company_settings: full,

  // --- Drive (the owner and admins manage everything; DM attachments are a DM's) -
  drive_folder: full,
  drive_file: meta(
    DM_FILE('t.id'),
    ['id', 'folder_id', 'owner_id', 'mime', 'size', 'created_at', 'updated_at', 'trashed_at', 'archived_at', 'archived_by', 'source', 'content_date', 'content_date_kind'],
    ['name', 'sha256'],
  ),
  drive_revision: meta(DM_FILE('t.file_id'), ['id', 'file_id', 'size', 'author_id', 'created_at'], ['sha256']),
  drive_source_items: full,
  drive_edit_lock: excluded('live edit locks'),

  // --- Messages (DMs are their participants’) --------------------------------
  message_conversations: meta(
    `t.kind = 'dm'`,
    ['id', 'kind', 'private', 'archived', 'dm_key', 'created_by', 'created_at'],
    ['name', 'topic'],
  ),
  message_conversation_members: full,
  messages: meta(
    inDm('t.conversation_id'),
    ['id', 'conversation_id', 'author_id', 'parent_id', 'created_at', 'edited_at', 'deleted_at', 'reply_to_id'],
    ['body', 'call'],
  ),
  message_reactions: meta(dmMessage('t.message_id'), ['message_id', 'user_id', 'created_at'], ['emoji']),
  message_attachments: meta(
    dmMessage('t.message_id'),
    ['message_id', 'file_id', 'position', 'mime', 'size', 'voice_duration_ms'],
    ['name'],
  ),
  message_events: full,
  message_drive_folders: full,

  // --- Email (personal mailboxes are their member’s) ----------------------------
  mailboxes: full,
  mailbox_addresses: full,
  inbox_messages: meta(
    personalMailbox('t.mailbox_id'),
    ['id', 'mailbox_id', 'folder', 'thread_id', 'received_at', 'read_at', 'starred', 'size_bytes', 'created_at'],
    ['message_id', 'ses_message_id', 'in_reply_to', 'references', 'from', 'to', 'cc', 'bcc', 'subject', 'snippet', 'text_body', 'html_body', 'verdicts', 'raw_s3_key'],
  ),
  inbox_attachments: meta(
    personalMail('t.message_id'),
    ['id', 'message_id', 'part_index', 'size_bytes', 'blocked', 'created_at'],
    ['filename', 'content_type', 'content_id', 'checksum'],
  ),
  inbox_labels: meta(personalMailbox('t.mailbox_id'), ['id', 'mailbox_id', 'created_by', 'created_at'], ['name', 'color']),
  inbox_message_labels: full,
  mail_domains: full,
  mail_senders: full,
  mail_messages: full,
  mail_message_events: full,
  mail_suppressions: full,
  mail_layouts: full,
  mail_templates: full,
  mail_contact_lists: full,
  mail_contacts: fullWith('token'),
  mail_flows: full,
  mail_flow_enrollments: full,
  mail_flow_log: full,
  mail_api_send: full,
  mail_jobs: excluded('mail send queue (in-flight jobs)'),
  mail_fake_sent: excluded('the test mail transport (no real mail)'),
  mail_fake_identities: excluded('the test mail transport (no real mail)'),
  owlery_settings: fullWith('sealed_secret_access_key'),
  managed_mail_sender: full,

  // --- Calendar (an event marked busy or private is its owner’s) ---------------
  calendar_events: meta(
    `t.visibility <> 'company'`,
    [
      'id', 'owner_id', 'starts_at', 'ends_at', 'time_zone', 'all_day', 'call_id', 'visibility', 'status', 'source',
      'external_id', 'etag', 'rrule', 'exdates', 'recurrence_ends_at', 'recurrence_id', 'original_start',
      'created_by', 'created_at', 'updated_at',
    ],
    ['title', 'notes', 'location'],
  ),
  calendar_attendees: meta(
    `EXISTS (SELECT 1 FROM calendar_events ev WHERE ev.id = t.event_id AND ev.visibility <> 'company')`, ['id', 'event_id', 'member_id', 'role', 'rsvp', 'created_at', 'updated_at'], ['email', 'name']),
  calendar_proposals: meta(
    always,
    ['id', 'member_id', 'mailbox_id', 'state', 'event_id', 'created_at', 'decided_at'],
    ['message_id', 'title', 'starts_at', 'ends_at', 'time_zone', 'location', 'call', 'attendees'],
  ),
  calendar_preferences: full,

  // --- Calls (a DM call is its participants’; a brain answer is the asker’s until shared) -
  call: meta(
    `t.context_kind = 'dm'`,
    ['id', 'room_name', 'context_kind', 'context_id', 'started_by', 'state', 'started_at', 'ended_at', 'scheduled_start', 'scheduled_end', 'external_url'],
    ['title'],
  ),
  call_participant: full,
  call_guest: fullWith('token_hash'),
  call_transcript_segment: meta(
    dmCall('t.call_id'),
    ['seq', 'call_id', 'speaker_id', 'speaker_kind', 'started_at', 'ended_at', 'created_at'],
    ['speaker_name', 'text'],
  ),
  call_chat_message: meta(
    dmCall('t.call_id'),
    ['seq', 'call_id', 'author_id', 'author_kind', 'created_at'],
    ['author_name', 'body'],
  ),
  call_brain_answer: meta('t.shared_at IS NULL', ['id', 'call_id', 'asked_by', 'asked_at', 'shared_at'], ['question', 'answer']),
  call_brain_listen: full,

  // --- Tasks between two people (work, not marked private: full) ------------
  assigned_tasks: full,
  assigned_task_comments: full,

  // --- Brand, website, repos, GitHub, contribute --------------------------------
  brand_assets: full,
  brand_calibration_cases: full,
  brand_corpus_staging: full,
  brand_criteria: full,
  brand_extraction_guides: full,
  brand_extraction_rounds: full,
  brand_extraction_sessions: full,
  brand_glossary: full,
  brand_guideline_sets: full,
  brand_judge_metrics: full,
  brand_lexicon: full,
  brand_social_media: full,
  brand_social_posts: full,
  brand_validations: full,
  brand_visual_sets: full,
  brand_visual_tokens: full,
  brand_voice_examples: full,
  website_content: full,
  website_contact: full,
  website_services: full,
  github_connection: fullWith('sealed_credentials'),
  github_app_links: full,
  github_connected_repos: full,
  repo_source_tokens: fullWith('token_sealed'),
  repo_sources: full,
  repo_source_files: full,
  contributions: full,
  contribution_votes: full,
  contribute_outbox: full,
  contribute_share_settings: full,
  hub_contributions: full,
  hub_installs: full,
  hub_request_counts: excluded('rate-limit counters'),
  hub_seen_signatures: excluded('replay guard (seen request signatures)'),
}

/**
 * Whole schemas that are server plumbing or derived, never company data: every
 * table in them (present or future) is left out with this reason.
 */
export const COMPANY_EXPORT_EXCLUDED_SCHEMAS: Record<string, string> = {
  eigen_graph: 'the Memory graph is derived from the Memory tables (rebuilt from them)',
  ag_catalog: 'Apache AGE extension catalog',
  cron: 'pg_cron schedule and run log (server plumbing)',
  net: 'pg_net HTTP queue (server plumbing)',
}
