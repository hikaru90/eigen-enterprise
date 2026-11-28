/**
 * The closed catalog of what the company's AI is used for (plan/phase-ai-usage-overview.md §1).
 * Every model call names one task; each task belongs to one product. The mapping is this table
 * (structure), never inferred from any text. Client-safe: no server imports.
 *
 * A task id is stored in activity_call_log.task: add ids freely, never rename or reuse one
 * (rows of an unknown id show as unattributed under their raw id).
 */

export const AI_PRODUCTS = {
  assistant: { label: 'Assistant', description: 'The company assistant’s replies and the files it reads.' },
  coworkers: { label: 'AI co-workers', description: 'The turns of the company’s AI co-workers.' },
  memory: { label: 'Memory', description: 'Capturing and enriching notes, tasks and projects.' },
  brain: { label: 'Brain', description: 'Retrieval, answers, grounding and the knowledge graph.' },
  decisions: { label: 'Decisions', description: 'Closed-set questions answered by the decision model (Jev).' },
  calls: { label: 'Calls', description: 'The brain’s answers and recaps in calls.' },
  contacts: { label: 'Contacts', description: 'Reading contacts out of text and suggesting next steps.' },
  calendar: { label: 'Calendar', description: 'Appointment proposals from mail.' },
  handover: { label: 'Handover', description: 'Handover sentences.' },
  repos: { label: 'Repos', description: 'Repository summaries.' },
  branding: { label: 'Branding', description: 'Brand extraction, captions and material texts.' },
  website: { label: 'Website', description: 'Page audience checks and app deploy help.' },
  drive: { label: 'Drive', description: 'Archive suggestions.' },
  contribute: { label: 'Contribute', description: 'Judging, scrubbing and summarising wishes and modules.' },
  email: { label: 'Email', description: 'Email’s own model calls (its routing decisions count under Decisions).' },
  speech: { label: 'Speech', description: 'Speech to text and the assistant’s voice.' },
  setup: { label: 'Setup', description: 'Provider connection tests and quality evaluations.' },
} as const satisfies Record<string, { label: string; description: string }>

export type AiProductId = keyof typeof AI_PRODUCTS
export const AI_PRODUCT_IDS = Object.keys(AI_PRODUCTS) as AiProductId[]

type AiTaskDef = {
  product: AiProductId
  label: string
  /**
   * The segment of activity_call_log.operation for this task's chat calls
   * (`llm.chat.<op>.success(…)`): the name the call had before this catalog, so the Activity
   * page and reply costs read as before. Absent: `chat`.
   */
  op?: string
}

export const AI_TASKS = {
  'assistant.turn': { product: 'assistant', label: 'Assistant replies', op: 'durable_agent' },
  'assistant.attachment_read': { product: 'assistant', label: 'Reading attachments', op: 'assistant_attachment_read' },

  'coworkers.turn': { product: 'coworkers', label: 'Co-worker turns', op: 'durable_agent' },

  'memory.interpret_preview': { product: 'memory', label: 'Capture preview', op: 'interpret_thought_preview' },
  'memory.interpret_preview_category_retry': { product: 'memory', label: 'Capture preview, category retry', op: 'interpret_thought_preview_category_retry' },
  'memory.split_capture': { product: 'memory', label: 'Splitting a capture' },
  'memory.enrich_thought_bundle': { product: 'memory', label: 'Enriching notes', op: 'enrich_thought_bundle' },
  'memory.enrich_category_retry': { product: 'memory', label: 'Enriching notes, category retry', op: 'enrich_thought_bundle_category_retry' },
  'memory.apply_thought_edit': { product: 'memory', label: 'Editing notes', op: 'apply_thought_edit' },
  'memory.thought_category': { product: 'memory', label: 'Note categories', op: 'thought_category' },
  'memory.ontology_evaluate': { product: 'memory', label: 'Ontology evaluation' },
  'memory.extract_cues': { product: 'memory', label: 'Extracting cues' },
  'memory.search_cues': { product: 'memory', label: 'Search cues', op: 'search_cues' },
  'memory.parse_date_range': { product: 'memory', label: 'Reading date ranges', op: 'timeline_parse_date_range' },
  'memory.temporal_extraction': { product: 'memory', label: 'Dates and deadlines' },
  'memory.temporal_event_action': { product: 'memory', label: 'Timeline actions', op: 'apply_temporal_event_action' },
  'memory.project_detect': { product: 'memory', label: 'Finding projects' },
  'memory.project_identity': { product: 'memory', label: 'Matching projects' },
  'memory.project_reconcile': { product: 'memory', label: 'Merging projects' },
  'memory.project_review': { product: 'memory', label: 'Project review' },
  'memory.project_timeline': { product: 'memory', label: 'Project timelines' },
  'memory.project_order': { product: 'memory', label: 'Task order' },
  'memory.gtd_assignment': { product: 'memory', label: 'Assigning tasks to projects' },
  'memory.gtd_project_judge': { product: 'memory', label: 'Judging projects' },
  'memory.capture_embedding': { product: 'memory', label: 'Note embeddings' },
  'memory.temporal_embedding': { product: 'memory', label: 'Timeline embeddings' },

  'brain.compose_answer': { product: 'brain', label: 'Answers from memory', op: 'compose_answer' },
  'brain.query_intent': { product: 'brain', label: 'Question intent', op: 'query_intent_classifier' },
  'brain.temporal_hints': { product: 'brain', label: 'Dates in questions', op: 'temporal_hint_bindings' },
  'brain.retrieval_rerank': { product: 'brain', label: 'Ranking search results', op: 'retrieval_rerank' },
  'brain.retrieval_embedding': { product: 'brain', label: 'Search embeddings' },
  'brain.delete_search_query': { product: 'brain', label: 'Finding what to delete', op: 'delete_search_query' },
  'brain.delete_target': { product: 'brain', label: 'Choosing what to delete', op: 'delete_target_resolver' },
  'brain.community_summary': { product: 'brain', label: 'Topic summaries', op: 'community_summary_batch' },
  'brain.grounding_next_question': { product: 'brain', label: 'Grounding questions', op: 'grounding_next_question' },
  'brain.grounding_narrative': { product: 'brain', label: 'Grounding narrative', op: 'grounding_narrative_synthesis' },
  'brain.grounding_seed_projects': { product: 'brain', label: 'First projects from grounding' },
  'brain.relevance_checkin': { product: 'brain', label: 'Relevance check-in questions', op: 'relevance_checkin_next_question' },
  'brain.entity_extraction': { product: 'brain', label: 'Graph entities' },
  'brain.relation_extraction': { product: 'brain', label: 'Graph relations' },
  'brain.entity_embedding': { product: 'brain', label: 'Entity embeddings' },
  'brain.patterns_digest': { product: 'brain', label: "What's happening digests" },

  'decisions.judge': { product: 'decisions', label: 'Decision model calls' },

  'calls.brain_answer': { product: 'calls', label: 'Answers in calls', op: 'call_brain_answer' },
  'calls.brain_recap': { product: 'calls', label: 'Call recaps', op: 'call_brain_recap' },

  'contacts.extract': { product: 'contacts', label: 'Reading contacts', op: 'contacts_extract' },
  'contacts.next_up': { product: 'contacts', label: 'Next steps', op: 'contacts_next_up' },

  'calendar.mail_proposal': { product: 'calendar', label: 'Appointments from mail', op: 'calendar_mail_proposal' },

  'handover.sentence': { product: 'handover', label: 'Handover sentences', op: 'handover_sentence' },

  'repos.summary': { product: 'repos', label: 'Repository summaries', op: 'repos_summary' },

  'branding.extract': { product: 'branding', label: 'Brand extraction', op: 'brand_extract' },
  'branding.extract_guide': { product: 'branding', label: 'Brand guide extraction', op: 'brand_extract_guide' },
  'branding.social_captions': { product: 'branding', label: 'Social captions', op: 'brand_social_captions' },
  'branding.material_texts': { product: 'branding', label: 'Material texts', op: 'brand_material_texts' },

  'website.page_audience': { product: 'website', label: 'Page audience check', op: 'website_page_audience' },
  'website.app_suggest': { product: 'website', label: 'App setup suggestions', op: 'website_app_suggest' },
  'website.app_diagnose': { product: 'website', label: 'Deploy diagnosis', op: 'app_deploy_diagnose' },

  'drive.archive_suggest': { product: 'drive', label: 'Archive suggestions', op: 'drive_archive_suggest' },

  'contribute.judge': { product: 'contribute', label: 'Judging wishes', op: 'contribute_judge' },
  'contribute.scrub': { product: 'contribute', label: 'Removing private details', op: 'contribute_scrub' },
  'contribute.module_summary': { product: 'contribute', label: 'Module summaries', op: 'module_hub_summary' },

  'speech.stt': { product: 'speech', label: 'Speech to text' },
  'speech.tts': { product: 'speech', label: 'Text to speech' },
  'speech.stt_judge': { product: 'speech', label: 'Transcript check', op: 'stt_judge' },

  'setup.provider_test': { product: 'setup', label: 'Provider connection tests' },
  'setup.eval': { product: 'setup', label: 'Quality evaluations' },
} as const satisfies Record<string, AiTaskDef>

export type AiTaskId = keyof typeof AI_TASKS
export const AI_TASK_IDS = Object.keys(AI_TASKS) as AiTaskId[]

export function isAiTaskId(value: string): value is AiTaskId {
  return Object.hasOwn(AI_TASKS, value)
}

/** The segment of activity_call_log.operation a chat call of this task writes. */
export function aiTaskOperation(task: AiTaskId): string {
  const def: AiTaskDef = AI_TASKS[task]
  return def.op ?? 'chat'
}
