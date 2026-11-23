/**
 * Registry-first (plan/phase-company-brain.md §1, CB4; AGENTS.md "No UI-only
 * actions"): everything clickable is a kernel registry action first, so the
 * `ee` CLI, MCP and the agent get it too; the UI is a client of the registry.
 *
 * This is the one declared map of every mutating entry point of the app — each
 * form action in a `+page.server.ts` and each POST / PUT / PATCH / DELETE /
 * fallback in a `+server.ts` (src/lib/kernel/route-scan.ts lists them) — to
 * exactly one of:
 *
 *   - `tool`      the route is a UI client of that registry action (same effect);
 *   - `humanOnly` it must stay a person's own act (sign-in, secrets, consent, …);
 *   - `transport` the route IS a transport, not an action: MCP, chat, provider
 *                 webhooks, cron triggers, speech, push and heartbeat plumbing;
 *   - `noEffect`  it changes no company state: a read or preview behind POST,
 *                 an AI draft for a form, or the person's own view state;
 *   - `debt`      a UI-only action today; it must gain a registry tool (stage 3,
 *                 CB8–CB13, one module each).
 *
 * src/lib/kernel/ui-parity.spec.ts fails on an unmapped entry point, on a key
 * whose route is gone, on a tool the registry does not have, and when the debt
 * count differs from DEBT_CEILING: debt can only shrink, and whoever clears
 * debt lowers the ceiling in the same commit. plan/parity-debt.md is generated
 * from this map by that spec (`npx vitest run src/lib/kernel/ui-parity.spec.ts -u`).
 *
 * Keys: `<route id> <METHOD>` or `<route id> ?/<action>` (`?/default` for a
 * default action), the route id with its (groups), as the scanner prints them.
 */

/** The modules debt is owed by (the stage-3 lanes); the spec checks each is a registered module. */
export type DebtModule =
  | 'assistant'
  | 'brand'
  | 'calendar'
  | 'calls'
  | 'contacts'
  | 'contribute'
  | 'drive'
  | 'email'
  | 'kernel'
  | 'members'
  | 'memory'
  | 'messages'
  | 'repos'
  | 'website'

export type UiParity =
  | { debt: DebtModule; note: string }
  | { humanOnly: string }
  | { noEffect: string }
  | { tool: string }
  | { transport: string }

/** The number of `debt` entries. Lower it when you clear debt; the spec fails if it is not exact. */
export const DEBT_CEILING = 0

const tool = (name: string): UiParity => ({ tool: name })
const human = (reason: string): UiParity => ({ humanOnly: reason })
const transport = (reason: string): UiParity => ({ transport: reason })
const noEffect = (reason: string): UiParity => ({ noEffect: reason })
// No `debt(...)` helper any more (debt is 0, owner 2026-11-23: a UI-only action is a bug).
// A new entry maps to a tool; `{ debt, note }` written out by hand fails the ceiling spec.

// ─── humanOnly: the short list, each with its reason ────────────────────────
const SIGN_IN = 'Sign-in, sign-up and account identity: a person proves who they are.'
const PROVIDER_SECRET = 'Provider credentials or OAuth: a person types, pastes or exchanges a secret.'
const API_KEYS = 'API keys: credentials are minted and revoked by a person, never by the agent.'
const GITHUB_TOKEN = 'A GitHub token: a credential a person pastes.'
const INTEGRATION =
  'An external integration (webhook endpoint or connected agent) with its own signing secret or callback token.'
const BACKUP_STORAGE = 'Backup storage credentials (S3 bucket keys), typed and tested by the owner.'
const RESTORE = 'Replaces the whole company’s data (the running app included) with a snapshot.'
const WIPE = 'An irreversible wipe of everything a person put in Memory, behind a typed confirmation.'
const MONEY = 'Spends money: buys a domain at a price the owner accepted, with registrant data.'
const CONSENT_HUB = 'Consent to send company data outside the company (the central Contribute board).'
const APPROVAL_MODE = 'The approval mode is the agent’s own leash: the agent must never loosen it.'
const CALL_PRESENCE = 'A person’s own presence in a live call: their device’s media session.'
const CALL_CONSENT = 'Consent to transcribe one’s own voice in a call.'
const CALL_GUEST =
  'A call guest without an account (token link): there is no principal the registry could act as.'

// ─── transport ──────────────────────────────────────────────────────────────
const MCP = 'The MCP endpoint: the registry’s own transport.'
const CHAT = 'The agent channel itself (chat with the assistant / the Company Brain).'
const WEBHOOK = 'A provider webhook (signature-verified), not a person’s action.'
const CRON = 'An operator/cron trigger behind the admin key, not a UI action.'
const HUB = 'The central board’s machine endpoint, called by other installs (signed per request).'
const E2E = 'Dev/e2e harness only (refused outside the harness).'
const PUBLIC = 'A public visitor or mail recipient (no account): a link or form outside the app.'
const API_KEY_ENDPOINT = 'An API-key endpoint for deployed apps and external callers (no session).'
const AGENT_CALLBACK = 'A connected external agent reporting back with its callback token.'
const SPEECH = 'Speech plumbing: audio to text or text to audio; it returns media and changes nothing.'
const PUSH = 'Push-notification plumbing for this device.'
const HEARTBEAT = 'A realtime heartbeat from an open tab (presence, what is on screen).'
const EDIT_LOCK = 'The browser editor’s session lock (acquire, heartbeat, release), not an action.'
const CLIENT_LOG = 'Client error logging into the server log.'

// ─── noEffect ───────────────────────────────────────────────────────────────
const VIEW_STATE = 'The person’s own view state (what their screen shows); no company effect.'
const PREVIEW = 'A preview: renders or checks a draft; nothing is saved or sent.'
const AI_DRAFT = 'An AI reading or suggestion for the page; nothing is saved (the agent reasons on its own).'

export const UI_PARITY: Record<string, UiParity> = {
  // ─── Drive › GitHub (repos) ───────────────────────────────────────────────
  '/(nucleus)/drive/github ?/addToken': human(GITHUB_TOKEN),
  '/(nucleus)/drive/github ?/removeToken': human(GITHUB_TOKEN),
  '/(nucleus)/drive/github ?/replaceToken': human(GITHUB_TOKEN),
  '/(nucleus)/drive/github ?/setCopyMode': tool('repos.set_copy_mode'),
  '/(nucleus)/drive/github ?/setRepo': tool('repos.set_repo'),
  '/(nucleus)/drive/github ?/syncNow': tool('repos.sync_now'),

  // ─── Calendar ─────────────────────────────────────────────────────────────
  '/(nucleus)/m/calendar ?/acceptProposal': tool('calendar.accept_proposal'),
  '/(nucleus)/m/calendar ?/delete': tool('calendar.delete_event'),
  '/(nucleus)/m/calendar ?/dismissProposal': tool('calendar.dismiss_proposal'),
  '/(nucleus)/m/calendar ?/preferences': tool('calendar.set_default_visibility'),
  '/(nucleus)/m/calendar ?/save': tool('calendar.update_event'),
  '/(nucleus)/m/calendar ?/weekNumbers': noEffect(VIEW_STATE),

  // ─── Email ────────────────────────────────────────────────────────────────
  '/(nucleus)/m/email/domains/[id] ?/delete': tool('email.domain_delete'),
  '/(nucleus)/m/email/domains/[id] ?/receiving': tool('email.domain_set_receiving'),
  '/(nucleus)/m/email/domains/[id] ?/recheck': tool('email.domain_recheck'),
  '/(nucleus)/m/email/domains/[id] ?/tracking': tool('email.domain_set_tracking'),
  '/(nucleus)/m/email/inbox ?/acceptProposal': tool('calendar.accept_proposal'),
  '/(nucleus)/m/email/inbox ?/createLabel': tool('email.label_create'),
  '/(nucleus)/m/email/inbox ?/createMine': tool('email.mailbox_create_mine'),
  '/(nucleus)/m/email/inbox ?/deleteLabel': tool('email.label_delete'),
  '/(nucleus)/m/email/inbox ?/dismissProposal': tool('calendar.dismiss_proposal'),
  '/(nucleus)/m/email/inbox ?/label': tool('email.mail_label'),
  '/(nucleus)/m/email/inbox ?/move': tool('email.mail_move'),
  '/(nucleus)/m/email/inbox ?/read': tool('email.mail_mark_read'),
  '/(nucleus)/m/email/inbox ?/send': tool('email.mail_send'),
  '/(nucleus)/m/email/inbox ?/star': tool('email.mail_star'),
  '/(nucleus)/m/email/inbox ?/unread': tool('email.mail_mark_read'),
  '/(nucleus)/m/email/inbox ?/unstar': tool('email.mail_star'),
  '/(nucleus)/m/email/layouts ?/create': tool('email.layout_create'),
  '/(nucleus)/m/email/layouts/[id] ?/delete': tool('email.layout_delete'),
  '/(nucleus)/m/email/layouts/[id] ?/save': tool('email.layout_update'),
  '/(nucleus)/m/email/logs/[id] ?/cancel': tool('email.log_cancel'),
  '/(nucleus)/m/email/mailboxes ?/alias': tool('email.mailbox_alias_add'),
  '/(nucleus)/m/email/mailboxes ?/assign': tool('email.mailbox_assign'),
  '/(nucleus)/m/email/mailboxes ?/disable': tool('email.mailbox_set_disabled'),
  '/(nucleus)/m/email/mailboxes ?/enable': tool('email.mailbox_set_disabled'),
  '/(nucleus)/m/email/mailboxes ?/removeAlias': tool('email.mailbox_alias_remove'),
  '/(nucleus)/m/email/mailboxes ?/shared': tool('email.mailbox_create_shared'),
  '/(nucleus)/m/email/marketing/flows ?/create': tool('email.flow_create'),
  '/(nucleus)/m/email/marketing/flows/[id] ?/delete': tool('email.flow_delete'),
  '/(nucleus)/m/email/marketing/flows/[id] ?/save': tool('email.flow_update'),
  '/(nucleus)/m/email/marketing/flows/[id] ?/status': tool('email.flow_set_status'),
  '/(nucleus)/m/email/marketing/lists ?/create': tool('email.list_create'),
  '/(nucleus)/m/email/marketing/lists/[id] ?/add': tool('email.contact_add'),
  '/(nucleus)/m/email/marketing/lists/[id] ?/delete': tool('email.list_delete'),
  '/(nucleus)/m/email/marketing/lists/[id] ?/import': tool('email.list_import'),
  '/(nucleus)/m/email/marketing/lists/[id] ?/remove': tool('email.contact_remove'),
  '/(nucleus)/m/email/marketing/lists/[id] ?/settings': tool('email.list_update'),
  '/(nucleus)/m/email/senders ?/add': tool('email.sender_add'),
  '/(nucleus)/m/email/senders ?/makeDefault': tool('email.sender_set_default'),
  '/(nucleus)/m/email/senders ?/remove': tool('email.sender_remove'),
  '/(nucleus)/m/email/setup ?/addDomain': tool('email.domain_add'),
  '/(nucleus)/m/email/setup ?/events': tool('email.setup_events'),
  '/(nucleus)/m/email/setup ?/receiving': tool('email.setup_receiving'),
  '/(nucleus)/m/email/setup ?/test': tool('email.send_mail'),
  '/(nucleus)/m/email/suppression ?/add': tool('email.suppression_add'),
  '/(nucleus)/m/email/suppression ?/remove': tool('email.suppression_remove'),
  '/(nucleus)/m/email/templates ?/create': tool('email.template_create'),
  '/(nucleus)/m/email/templates/[id] ?/delete': tool('email.template_delete'),
  '/(nucleus)/m/email/templates/[id] ?/save': tool('email.template_update'),
  '/(nucleus)/m/email/templates/[id] ?/test': tool('email.template_send_test'),
  '/api/mail/send POST': transport(API_KEY_ENDPOINT),
  '/api/mail/ses-events POST': transport(WEBHOOK),
  '/api/mail/ses-inbound POST': transport(WEBHOOK),
  '/api/mail/subscribe POST': transport(API_KEY_ENDPOINT),
  '/api/mail/templates/preview POST': noEffect(PREVIEW),
  '/api/mail/unsubscribe/[token] POST': transport(PUBLIC),
  '/api/domains/connected POST': tool('email.domain_add'),
  '/api/domains/connected/[id]/check POST': tool('email.domain_recheck'),
  '/api/domains/purchases POST': human(MONEY),
  '/api/onboarding/sender POST': tool('email.sender_set_default'),
  '/mail/confirm/[token] ?/default': transport(PUBLIC),
  '/mail/subscribe/[listId] ?/default': transport(PUBLIC),
  '/mail/unsubscribe/[token] ?/default': transport(PUBLIC),

  // ─── Contacts (Email › People) ────────────────────────────────────────────
  '/(nucleus)/m/email/people ?/log': tool('contacts.log_contact'),
  '/(nucleus)/m/email/people/[id] ?/delete': tool('contacts.delete'),
  '/(nucleus)/m/email/people/[id] ?/log': tool('contacts.log_contact'),
  '/(nucleus)/m/email/people/[id] ?/save': tool('contacts.update'),
  '/(nucleus)/m/email/people/[id] ?/share': tool('contacts.set_shared'),
  '/(nucleus)/m/email/people/import ?/import': tool('contacts.import'),
  '/(nucleus)/m/email/people/import ?/preview': noEffect(PREVIEW),
  '/(nucleus)/m/email/people/new ?/default': tool('contacts.create'),
  '/(nucleus)/m/email/people/pipeline ?/log': tool('contacts.log_contact'),
  '/(nucleus)/m/email/people/pipeline ?/update': tool('contacts.update'),
  '/(nucleus)/m/email/people/settings ?/company': tool('contacts.set_company_default_visibility'),
  '/(nucleus)/m/email/people/settings ?/mine': tool('contacts.set_my_default_visibility'),
  '/api/contacts/extract POST': noEffect(AI_DRAFT),
  '/api/contacts/next-up POST': noEffect(AI_DRAFT),
  '/api/contacts/sharing POST': tool('contacts.share_many'),

  // ─── Memory ───────────────────────────────────────────────────────────────
  '/(nucleus)/m/memory/capture ?/completeOnboarding': noEffect(VIEW_STATE),
  '/(nucleus)/m/memory/capture ?/skipOnboarding': noEffect(VIEW_STATE),
  '/(nucleus)/m/memory/projects/roadmap ?/add': tool('roadmap.add_item'),
  '/(nucleus)/m/memory/projects/roadmap ?/update': tool('roadmap.update_item'),
  '/(nucleus)/m/memory/reminders ?/complete': tool('reminders.complete'),
  '/(nucleus)/m/memory/reminders ?/create': tool('reminders.create'),
  '/(nucleus)/m/memory/reminders ?/delete': tool('reminders.delete'),
  '/(nucleus)/m/memory/reminders ?/pause': tool('reminders.pause'),
  '/(nucleus)/m/memory/reminders ?/resume': tool('reminders.resume'),
  '/(nucleus)/m/memory/reminders ?/snooze': tool('reminders.snooze'),
  '/(nucleus)/m/memory/reminders ?/update': tool('reminders.update'),
  '/(nucleus)/m/memory/settings ?/deleteAll': human(WIPE),
  '/(nucleus)/m/memory/settings ?/deleteArchived': tool('memory.delete_archived_thoughts'),
  '/(nucleus)/m/memory/settings ?/settings': tool('notifications.settings_set'),
  '/(nucleus)/m/memory/tasks ?/comment': tool('tasks.comment'),
  '/(nucleus)/m/memory/tasks ?/complete': tool('tasks.complete'),
  '/(nucleus)/m/memory/tasks ?/seen': tool('tasks.mark_seen'),
  '/api/capture/confirm POST': tool('memory.capture_thought'),
  '/api/capture/edit POST': tool('memory.edit_thought'),
  '/api/capture/enrich-retry POST': tool('memory.retry_enrichment'),
  '/api/capture/interpret POST': tool('memory.capture_thought'),
  '/api/capture/relink POST': tool('memory.relink_thought'),
  '/api/capture/submit POST': tool('memory.capture_thought'),
  '/api/capture/transcribe POST': transport(SPEECH),
  '/api/capture/transcribe-chunk POST': transport(SPEECH),
  '/api/entities/[entityId] DELETE': tool('memory.delete_entity'),
  '/api/entities/[entityId] PATCH': tool('memory.update_entity'),
  '/api/entities/[entityId]/sync POST': tool('memory.sync_entity'),
  '/api/graph/rearrange POST': tool('memory.clean_up_graph'),
  '/api/grounding/onboarding-welcome-push POST': transport(PUSH),
  '/api/grounding/question POST': tool('memory.answer_check_in'),
  '/api/memories DELETE': human(WIPE),
  '/api/retrieval/search POST': tool('memory.retrieve_thoughts'),
  '/api/scheduled-tasks/[taskId] DELETE': tool('memory.stop_scheduled_task'),
  '/api/scheduled-tasks/[taskId] PATCH': tool('memory.pause_scheduled_task'),
  '/api/scheduled-tasks/[taskId] POST': tool('memory.run_scheduled_task'),
  '/api/scheduled-tasks/[taskId]/retry POST': tool('memory.retry_scheduled_task_step'),
  '/api/temporal-events/[id] DELETE': tool('memory.delete_task'),
  '/api/temporal-events/[id]/action POST': tool('memory.set_timeline_item_status'),
  '/api/text-files POST': tool('memory.create_text_file'),
  '/api/text-files/[fileId] DELETE': tool('memory.delete_text_file'),
  '/api/text-files/[fileId] PATCH': tool('memory.update_text_file'),
  '/api/text-files/[fileId]/visibility POST': tool('memory.set_text_file_visibility'),
  '/api/thoughts/[thoughtId] DELETE': tool('memory.delete_thought'),
  '/api/thoughts/[thoughtId] PATCH': tool('memory.set_thought_status'),
  '/api/thoughts/[thoughtId]/text-files POST': tool('memory.link_text_file'),
  '/api/thoughts/[thoughtId]/text-files/[fileId] DELETE': tool('memory.unlink_text_file'),
  '/api/timeline/parse-date-range POST': noEffect('A helper: parses a typed date range for the timeline filter.'),
  '/api/timeline/plan-week POST': noEffect(AI_DRAFT),
  '/api/timeline/projects POST': tool('memory.create_project'),
  '/api/timeline/projects/[entityId]/deadline POST': tool('memory.set_project_deadline'),
  '/api/timeline/projects/[entityId]/dismiss POST': tool('memory.dismiss_project'),
  '/api/timeline/projects/[entityId]/milestones POST': tool('memory.set_project_milestone'),
  '/api/timeline/projects/[entityId]/order POST': tool('memory.order_project_task'),
  '/api/timeline/projects/[entityId]/review POST': noEffect(AI_DRAFT),
  '/api/timeline/projects/[entityId]/review/apply POST': tool('memory.apply_project_review'),
  '/api/timeline/projects/[entityId]/update PUT': tool('memory.rename_project'),
  '/api/timeline/projects/[entityId]/visibility POST': tool('memory.set_project_visibility'),
  '/api/timeline/projects/assign POST': tool('memory.assign_thought_project'),
  '/api/agents/[id]/assign POST': tool('memory.assign_thought_to_agent'),
  '/api/agents/[id]/projects POST': tool('memory.bind_agent_project'),
  '/api/agents/[id]/projects/[projectId] DELETE': tool('memory.unbind_agent_project'),

  // ─── Website ──────────────────────────────────────────────────────────────
  '/(nucleus)/m/website/apps/[name] ?/deploy': tool('website.app_deploy'),
  '/(nucleus)/m/website/apps/[name] ?/env': tool('website.app_env_set'),
  '/(nucleus)/m/website/apps/[name] ?/mailDisable': tool('website.app_mail_disable'),
  '/(nucleus)/m/website/apps/[name] ?/mailEnable': tool('website.app_mail_enable'),
  '/(nucleus)/m/website/apps/[name] ?/remove': tool('website.app_remove'),
  '/(nucleus)/m/website/apps/[name] ?/secretSet': tool('substrate.secret_set'),
  '/(nucleus)/m/website/apps/[name]/deploy POST': tool('website.app_deploy'),
  '/(nucleus)/m/website/apps/[name]/diagnose POST': tool('website.app_diagnose'),
  '/(nucleus)/m/website/apps/new ?/connect': tool('website.github_connect_repo'),
  '/(nucleus)/m/website/apps/new ?/deploy': tool('website.app_deploy'),
  '/(nucleus)/m/website/apps/new ?/deployKeyCancel': tool('website.github_deploy_key_delete'),
  '/(nucleus)/m/website/apps/new ?/deployKeyCheck': tool('website.github_deploy_key_check'),
  '/(nucleus)/m/website/apps/new ?/deployKeyCreate': tool('website.github_deploy_key_create'),
  '/(nucleus)/m/website/apps/new ?/disconnect': tool('website.github_disconnect_repo'),
  '/(nucleus)/m/website/apps/new ?/inspect': tool('website.github_inspect_repo'),
  '/(nucleus)/m/website/apps/suggest POST': tool('website.app_suggest_contract'),
  '/s/[slug] ?/deletePage': tool('website.delete_page'),
  '/api/github/webhook POST': transport(WEBHOOK),
  '/api/website/contact POST': transport(PUBLIC),
  '/api/onboarding/founding POST': tool('website.found_company'),

  // ─── Brand ────────────────────────────────────────────────────────────────
  '/api/brand/corpus POST': tool('brand.corpus_list'),
  '/api/brand/corpus/similar POST': tool('brand.corpus_similar'),
  '/api/brand/extract/accept POST': tool('brand.extract_accept'),
  '/api/brand/extract/guide POST': tool('brand.extract_guide_start'),
  '/api/brand/extract/judge POST': tool('brand.extract_judge'),
  '/api/brand/extract/propose POST': tool('brand.extract_propose'),
  '/api/brand/extract/session/[id] POST': tool('brand.extract_session_get'),
  '/api/brand/extract/start POST': tool('brand.extract_start'),
  '/api/brand/picker/choose POST': tool('brand.picker_choose'),
  '/api/brand/selection/matches POST': tool('brand.selection_matches'),
  '/api/brand/social/posts POST': tool('brand.social_post_upload'),
  '/api/brand/social/posts/[id] DELETE': tool('brand.social_post_delete'),
  '/api/brand/social/posts/[id] PATCH': tool('brand.social_post_update'),
  '/api/brand/social/posts/[id]/captions POST': tool('brand.social_caption_suggest'),
  '/api/brand/visual-sets POST': tool('brand.visual_set_create'),
  '/api/brand/visual-sets/[id] POST': tool('brand.visual_set_get'),
  '/api/brand/visual-sets/[id]/update POST': tool('brand.visual_set_update'),

  // ─── Drive ────────────────────────────────────────────────────────────────
  '/api/drive/apps/[previewId] DELETE': tool('drive.app_stop'),
  '/api/drive/archive POST': tool('drive.archive'),
  '/api/drive/archive/suggestions POST': tool('drive.suggest_archive'),
  '/api/drive/documents POST': tool('drive.create_document'),
  '/api/drive/files/[id]/content PUT': tool('drive.save_file_bytes'),
  '/api/drive/files/[id]/lock DELETE': transport(EDIT_LOCK),
  '/api/drive/files/[id]/lock POST': transport(EDIT_LOCK),
  '/api/drive/files/[id]/lock PUT': transport(EDIT_LOCK),
  '/api/drive/files/[id]/revisions POST': tool('drive.restore_revision'),
  '/api/drive/files/[id]/text PUT': tool('drive.write_text'),
  '/api/drive/folders POST': tool('drive.create_folder'),
  '/api/drive/folders/[id]/app DELETE': tool('drive.app_stop'),
  '/api/drive/folders/[id]/app POST': tool('drive.app_run'),
  '/api/drive/items/[type]/[id] DELETE': tool('drive.trash'),
  '/api/drive/items/[type]/[id] PATCH': tool('drive.rename'),
  '/api/drive/items/[type]/[id]/archive DELETE': tool('drive.unarchive'),
  '/api/drive/items/[type]/[id]/archive POST': tool('drive.archive'),
  '/api/drive/items/[type]/[id]/grants PUT': tool('drive.set_sharing'),
  '/api/drive/items/[type]/[id]/restore POST': tool('drive.restore'),
  '/api/drive/upload POST': tool('drive.upload'),

  // ─── Messages ─────────────────────────────────────────────────────────────
  '/api/messages/channels POST': tool('messages.create_channel'),
  '/api/messages/conversations/[id]/attachments POST': tool('messages.upload_attachments'),
  '/api/messages/conversations/[id]/messages POST': tool('messages.post'),
  '/api/messages/conversations/[id]/read POST': tool('messages.mark_read'),
  '/api/messages/dms POST': tool('messages.open_dm'),
  '/api/messages/messages/[id] DELETE': tool('messages.delete'),
  '/api/messages/messages/[id] PATCH': tool('messages.edit'),
  '/api/messages/messages/[id]/reactions POST': tool('messages.react'),
  '/api/messages/presence POST': transport(HEARTBEAT),
  '/api/messages/presence PUT': tool('messages.set_do_not_disturb'),
  '/api/messages/viewing POST': transport(HEARTBEAT),

  // ─── Calls ────────────────────────────────────────────────────────────────
  '/api/calls POST': tool('calls.start'),
  '/api/calls/[id]/accept POST': human(CALL_PRESENCE),
  '/api/calls/[id]/brain POST': tool('calls.brain_set'),
  '/api/calls/[id]/brain/answers/[answerId]/share POST': tool('calls.brain_share_answer'),
  '/api/calls/[id]/brain/ask POST': transport(CHAT),
  '/api/calls/[id]/brain/recap POST': tool('calls.brain_recap'),
  '/api/calls/[id]/decline POST': human(CALL_PRESENCE),
  '/api/calls/[id]/guests POST': tool('calls.invite_guests'),
  '/api/calls/[id]/guests/[guestId] DELETE': tool('calls.remove_guest'),
  '/api/calls/[id]/hangup POST': human(CALL_PRESENCE),
  '/api/calls/[id]/transcript POST': transport(SPEECH),
  '/api/calls/[id]/transcription POST': human(CALL_CONSENT),
  '/api/calls/guest/[token]/join POST': human(CALL_GUEST),
  '/api/calls/guest/[token]/leave POST': human(CALL_GUEST),
  '/api/calls/guest/[token]/transcript POST': transport(SPEECH),
  '/api/calls/guest/[token]/transcription POST': human(CALL_GUEST),
  '/api/calls/livekit POST': transport(WEBHOOK),
  '/api/calls/meetings POST': tool('calls.schedule'),

  // ─── Contribute ───────────────────────────────────────────────────────────
  '/api/contribute POST': tool('contribute.propose'),
  '/api/contribute/[id] PATCH': tool('contribute.update'),
  '/api/contribute/[id]/share DELETE': human(CONSENT_HUB),
  '/api/contribute/[id]/vote POST': tool('contribute.vote'),
  '/api/contribute/check POST': noEffect(AI_DRAFT),
  '/api/hub/contributions/[remoteId] DELETE': transport(HUB),
  '/api/hub/contributions/[remoteId] PUT': transport(HUB),
  '/api/hub/installs/[installId] DELETE': transport(HUB),
  '/api/hub/register POST': transport(HUB),

  // ─── Assistant ────────────────────────────────────────────────────────────
  '/api/chat POST': transport(CHAT),
  '/api/assistant/attachments POST': transport(CHAT),
  '/api/agent/runs/[id] PATCH': tool('assistant.conversation_rename'),
  '/api/tts POST': transport(SPEECH),
  '/api/voice/transcribe POST': transport(SPEECH),

  // ─── Members and the person ───────────────────────────────────────────────
  '/(nucleus)/settings/members ?/createGroup': tool('members.group_create'),
  '/(nucleus)/settings/members ?/deleteGroup': tool('members.group_delete'),
  '/(nucleus)/settings/members ?/invite': tool('members.invite'),
  '/(nucleus)/settings/members ?/remove': tool('members.remove'),
  '/(nucleus)/settings/members ?/setOpenJoin': tool('members.set_open_join'),
  '/(nucleus)/settings/members ?/setRole': tool('members.set_role'),
  '/(nucleus)/settings/members ?/updateGroup': tool('members.group_update'),
  '/api/onboarding/name POST': tool('members.set_my_called'),
  '/api/profile PUT': tool('members.set_my_name'),
  '/api/profile/avatar POST': tool('members.set_my_picture'),

  // ─── Settings and the kernel ──────────────────────────────────────────────
  '/(nucleus)/settings ?/changeEmail': human(SIGN_IN),
  '/(nucleus)/settings/backups ?/check': noEffect('Verifies one backup end to end (download, decrypt, hash); writes nothing.'),
  '/(nucleus)/settings/backups ?/run': tool('kernel.backup_run'),
  '/(nucleus)/settings/export ?/delete': tool('kernel.export_delete'),
  '/(nucleus)/settings/export ?/start': tool('kernel.export_company'),
  '/(nucleus)/settings/backups ?/save': human(BACKUP_STORAGE),
  '/(nucleus)/settings/backups ?/test': human(BACKUP_STORAGE),
  '/(nucleus)/settings/backups/restore/[snapshot] ?/restore': human(RESTORE),
  '/(nucleus)/settings/company ?/recropLogo': tool('settings.logo_recrop'),
  '/(nucleus)/settings/company ?/removeLogo': tool('settings.logo_remove'),
  '/(nucleus)/settings/company ?/saveName': tool('settings.update'),
  '/(nucleus)/settings/company ?/setSharing': human(CONSENT_HUB),
  '/(nucleus)/settings/company ?/uploadLogo': tool('settings.logo_set'),
  '/(nucleus)/settings/domains ?/addHost': tool('domains.set_target'),
  '/(nucleus)/settings/domains ?/recheck': tool('domains.recheck'),
  '/(nucleus)/settings/domains ?/remove': tool('domains.remove'),
  '/(nucleus)/settings/domains ?/retryCertificate': tool('domains.retry_certificate'),
  '/(nucleus)/settings/domains ?/setTarget': tool('domains.set_target'),
  '/(nucleus)/settings/llm ?/saveLlmConfig': human(PROVIDER_SECRET),
  '/(nucleus)/settings/llm ?/saveModelConfig': tool('settings.update'),
  '/(nucleus)/settings/llm ?/setActiveProvider': tool('settings.update'),
  '/(nucleus)/settings/llm ?/setEigenInference': tool('settings.update'),
  '/(nucleus)/settings/llm ?/setMemberAiCap': tool('settings.member_ai_cap_set'),
  '/(nucleus)/settings/llm ?/setSlot': tool('settings.update'),
  '/(nucleus)/settings/llm/byok/[provider] ?/saveLlmConfig': human(PROVIDER_SECRET),
  '/(nucleus)/settings/llm/byok/[provider] ?/saveModelConfig': tool('settings.update'),
  '/(nucleus)/settings/llm/byok/[provider] ?/setActiveProvider': tool('settings.update'),
  '/(nucleus)/settings/llm/byok/[provider] ?/setEigenInference': tool('settings.update'),
  '/(nucleus)/settings/llm/byok/[provider] ?/setMemberAiCap': tool('settings.member_ai_cap_set'),
  '/(nucleus)/settings/llm/byok/[provider] ?/setSlot': tool('settings.update'),
  '/(nucleus)/settings/modules ?/activate': tool('kernel.module_activate'),
  '/(nucleus)/settings/modules ?/deactivate': tool('kernel.module_deactivate'),
  '/(nucleus)/settings/updates ?/update': tool('kernel.release_install'),
  '/api/approvals/[id] POST': tool('kernel.approvals_decide'),
  '/api/approvals/mode PUT': human(APPROVAL_MODE),
  '/api/settings/dashboard-tiles PUT': noEffect(VIEW_STATE),
  '/api/settings/notifications PUT': tool('notifications.settings_set'),
  '/api/activity POST': noEffect('A read: the person’s own model-call log and spend.'),
  '/api/keys POST': human(API_KEYS),
  '/api/keys/[id] DELETE': human(API_KEYS),
  '/api/keys/[id] PATCH': human(API_KEYS),
  '/api/agents POST': human(INTEGRATION),
  '/api/agents/[id] DELETE': human(INTEGRATION),
  '/api/agents/[id] PATCH': human(INTEGRATION),
  '/api/agents/[id]/test POST': human(INTEGRATION),
  '/api/agents/callback/complete POST': transport(AGENT_CALLBACK),
  '/api/webhooks/inbound POST': transport(WEBHOOK),
  '/api/webhooks/inbound/manage POST': human(INTEGRATION),
  '/api/webhooks/inbound/manage/[id] DELETE': human(INTEGRATION),
  '/api/webhooks/inbound/manage/[id] PATCH': human(INTEGRATION),
  '/api/mcp DELETE': transport(MCP),
  '/api/mcp POST': transport(MCP),
  '/api/admin/consolidate POST': transport(CRON),
  '/api/admin/dispatch-reminders POST': transport(CRON),
  '/api/admin/reenrich POST': transport(CRON),
  '/api/admin/tick-job-queue POST': transport(CRON),
  '/api/log/error POST': transport(CLIENT_LOG),
  '/api/push/subscribe POST': transport(PUSH),
  '/api/push/test POST': tool('notifications.test'),
  '/api/push/unsubscribe POST': transport(PUSH),

  // ─── Onboarding ───────────────────────────────────────────────────────────
  '/api/onboarding/copilot/poll POST': human(PROVIDER_SECRET),
  '/api/onboarding/copilot/start POST': human(PROVIDER_SECRET),
  '/api/onboarding/mail POST': human(PROVIDER_SECRET),
  '/api/onboarding/openrouter/authorize POST': human(PROVIDER_SECRET),
  '/api/onboarding/provider POST': human(PROVIDER_SECRET),
  '/api/onboarding/test-provider POST': human(PROVIDER_SECRET),
  '/api/onboarding/welcome POST': noEffect(VIEW_STATE),
  '/api/onboarding/welcome/reset POST': noEffect(VIEW_STATE),

  // ─── Sign-in, sign-up, session ────────────────────────────────────────────
  '/api/session/sign-out POST': human(SIGN_IN),
  '/claim ?/default': human(SIGN_IN),
  '/invite ?/join': human(SIGN_IN),
  '/login ?/sendCode': human(SIGN_IN),
  '/login ?/verifyCode': human(SIGN_IN),
  '/owner-link ?/default': human(SIGN_IN),
  '/signup ?/sendCode': human(SIGN_IN),
  '/signup ?/verifyCode': human(SIGN_IN),

  // ─── Dev/e2e harness ──────────────────────────────────────────────────────
  '/api/e2e/graph-scale/spend/init POST': transport(E2E),
  '/api/e2e/graph-scale/spend/step POST': transport(E2E),
  '/api/e2e/harness/contribute-share POST': transport(E2E),
  '/api/e2e/harness/ensure-credentials POST': transport(E2E),
  '/api/e2e/harness/inbox POST': transport(E2E),
  '/api/e2e/harness/mail DELETE': transport(E2E),
  '/api/e2e/harness/mail POST': transport(E2E),
}

export type ParityKind = 'debt' | 'humanOnly' | 'noEffect' | 'tool' | 'transport'

export function parityKind(entry: UiParity): ParityKind {
  if ('tool' in entry) return 'tool'
  if ('debt' in entry) return 'debt'
  if ('humanOnly' in entry) return 'humanOnly'
  if ('transport' in entry) return 'transport'
  return 'noEffect'
}

/** plan/parity-debt.md, generated from the map (the spec keeps the file equal to this). */
export function debtSummaryMarkdown(map: Record<string, UiParity> = UI_PARITY): string {
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  const counts: Record<ParityKind, number> = { debt: 0, humanOnly: 0, noEffect: 0, tool: 0, transport: 0 }
  const byModule = new Map<DebtModule, { key: string; note: string }[]>()
  for (const [key, entry] of entries) {
    counts[parityKind(entry)] += 1
    if ('debt' in entry) {
      const list = byModule.get(entry.debt) ?? []
      list.push({ key, note: entry.note })
      byModule.set(entry.debt, list)
    }
  }
  const modules = [...byModule.entries()].sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
  const lines = [
    '# Parity debt: UI-only actions that must become registry actions',
    '',
    '<!-- Generated from src/lib/kernel/ui-parity.ts by src/lib/kernel/ui-parity.spec.ts. Do not edit by hand:',
    '     change the map, then run `npx vitest run src/lib/kernel/ui-parity.spec.ts -u`. -->',
    '',
    'Registry-first (plan/phase-company-brain.md §1, CB4): everything clickable is a kernel registry',
    'action first, so the `ee` CLI, MCP and the agent get it too. Every mutating entry point of the app',
    '(form actions, POST/PUT/PATCH/DELETE handlers) is mapped in `src/lib/kernel/ui-parity.ts`; the gate',
    'fails on an unmapped one, and the debt below can only shrink (`DEBT_CEILING`). Each stage-3',
    'milestone (CB8–CB13) clears its module’s section.',
    '',
    `Mutating entry points: **${entries.length}** — tool ${counts.tool}, human-only ${counts.humanOnly}, ` +
      `transport ${counts.transport}, no effect ${counts.noEffect}, **debt ${counts.debt}**.`,
    '',
    '| Module | Debt |',
    '|---|---|',
    ...modules.map(([module, list]) => `| ${module} | ${list.length} |`),
    '',
  ]
  for (const [module, list] of modules) {
    lines.push(`## ${module} (${list.length})`, '')
    for (const { key, note } of list) lines.push(`- \`${key}\` — ${note}`)
    lines.push('')
  }
  return lines.join('\n')
}
