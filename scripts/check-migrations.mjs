/**
 * Migrations: the expand/contract lint (in the gate) and a database diagnostic (run on a box).
 *
 *   node scripts/check-migrations.mjs lint   lint drizzle/ — no database; `npm run lint:migrations`, part of ci:local
 *   node scripts/check-migrations.mjs        diagnose a database's migration state (DATABASE_URL)
 *
 * Core schema is expand/contract (plan/phase-upgrades.md §5): during blue/green and after a
 * rollback the PREVIOUS release runs against the NEW schema, so an ordinary migration only adds.
 * Two markers, each only as the file's FIRST line:
 *
 *   -- ee:contract         the file may drop, rename, retype or tighten (DROP TABLE/COLUMN/TYPE …,
 *                          RENAME, ALTER COLUMN … TYPE, SET NOT NULL, a NOT NULL column without a
 *                          default …). Ship it one release AFTER the code stopped reading the thing.
 *                          The first release containing it becomes the downgrade floor
 *                          (scripts/downgrade-floor.mjs).
 *   -- ee:no-transaction   scripts/migrate.mjs runs the file statement by statement outside a
 *                          transaction (every other file runs in its own transaction). Only
 *                          statements that cannot run inside one may appear: CREATE/DROP INDEX
 *                          CONCURRENTLY, REINDEX … CONCURRENTLY, ALTER TYPE … ADD VALUE.
 *
 * The SQL is tokenized (strings, E'' strings, quoted identifiers, dollar quotes and nested
 * comments respected) and split into statements; DO blocks are looked into, function bodies are
 * not (they don't run at migration time). Dynamic SQL (EXECUTE '…') is not inspected.
 * Migrations up to and including BASELINED_MIGRATIONS' last tag predate the lint and are listed
 * by name; the destructive-statement rule applies from the next migration on.
 */
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Migrations written before the expand/contract lint existed (idx 0–177), by tag. Never add to this. */
export const BASELINED_MIGRATIONS = Object.freeze([
  '0000_classy_greymalkin',
  '0001_ontology_tables',
  '0002_amused_gamora',
  '0003_graceful_big_bertha',
  '0004_tranquil_lightspeed',
  '0005_thought_category_ontology_fk',
  '0006_thought_category_ontology_fk2',
  '0007_thought_kind_fk_restrict',
  '0008_chat_message_metadata',
  '0009_llm_provider_fields',
  '0010_practical_ontology',
  '0011_memory_system_v2',
  '0012_activity_call_log_context',
  '0013_eval_tables',
  '0014_eval_scenario',
  '0015_eval_qa',
  '0016_eval_qa_captures',
  '0017_drop_eval_scenario',
  '0018_eval_qa_extensions',
  '0019_eval_qa_checks',
  '0020_eval_qa_contact_conflict_haystack',
  '0021_temporal_memory',
  '0022_activity_call_log_gateway_host',
  '0023_eval_qa_surgical_memory',
  '0024_eval_qa_tlif_entity_surfaces',
  '0025_push_subscription',
  '0026_billing_wallet',
  '0027_preferred_ui_locale',
  '0028_consolidation_run',
  '0029_heartbeat_run',
  '0030_heartbeat_run_progress',
  '0031_wallet_pending_billing_micro_usd',
  '0032_user_role',
  '0033_temporal_event_graph_node_id',
  '0034_tenant_envelope_encryption',
  '0035_wallet_eigen_credits',
  '0036_eval_qa_restore_jonas_retrieval',
  '0037_fast_retrieval',
  '0038_enrich_queue_status',
  '0039_temporal_event_lifecycle',
  '0040_grounding_profile',
  '0041_temporal_event_task_metadata',
  '0042_user_daily_work_minutes',
  '0043_daily_summary_notifications',
  '0044_project_profile',
  '0045_text_file',
  '0046_project_profile_source',
  '0047_user_job_queue',
  '0048_connected_agents',
  '0049_user_account_kind',
  '0050_payment_order_checkout_pricing',
  '0051_agent_project_binding',
  '0052_agent_labeled_memory',
  '0053_shallow_spacker_dave',
  '0054_thought_lifecycle',
  '0055_resolve_user_api_key_name',
  '0056_fix_resolve_user_api_key_key_name',
  '0057_drop_duplicate_resolve_user_api_key',
  '0058_preferred_timezone_offset_minutes',
  '0059_daily_summary_dispatch_error',
  '0060_repair_thought_lifecycle_drift',
  '0061_project_on_entity',
  '0062_connected_agent_signature_mode',
  '0063_feedback',
  '0064_grounding_push_tracking',
  '0065_schema_integrity',
  '0066_project_timelines',
  '0067_single_type_axis',
  '0068_user_first_last_name',
  '0069_erpnext_invoice_sync',
  '0070_kernel_tables',
  '0071_gateway_tables',
  '0072_website_tables',
  '0073_devagent_runs',
  '0074_kernel_event_source',
  '0075_llm_provider_oauth',
  '0076_branding_tables',
  '0077_journeys',
  '0078_agent_session_events',
  '0079_brand_extraction',
  '0080_brand_visual_sets',
  '0081_brand_visual_set_pins',
  '0082_welcome_onboarding',
  '0083_user_display_name',
  '0084_extension_roadmap',
  '0085_github_connection',
  '0086_durable_conversations',
  '0087_company_mail',
  '0088_owlery_settings',
  '0089_provider_orchestrator_engine',
  '0090_kernel_approval_mode',
  '0091_durable_only_providers',
  '0092_module_merge',
  '0093_github_connected_repos',
  '0094_github_deploy_keys',
  '0095_website_services',
  '0096_members',
  '0097_mail_api_send',
  '0098_user_api_key_mcp',
  '0099_website_services_mail_key',
  '0100_user_passkeys',
  '0101_website_services_contract',
  '0102_website_pages_dropped',
  '0103_durable_background_runs',
  '0104_mail_fake_transport',
  '0105_brand_visual_set_picker_node',
  '0106_drop_dev_agent_tables',
  '0107_team_groups_access',
  '0108_messages_core',
  '0109_drive',
  '0110_drive_edit_lock',
  '0111_messages_depth',
  '0112_gitstore_watermark',
  '0113_user_profile',
  '0114_email_platform',
  '0115_email_templates',
  '0116_email_contacts_flows',
  '0120_roadmap_into_memory',
  '0121_contributions',
  '0122_calls',
  '0123_message_call_lines',
  '0124_contacts',
  '0125_company_profile',
  '0126_drive_archive',
  '0127_brand_guide_upload',
  '0128_capture_session_thought',
  '0129_mailboxes',
  '0130_mail_receiving',
  '0131_inbox_attachments',
  '0132_webmail_send',
  '0133_drive_sources',
  '0134_repos',
  '0135_repos_summary',
  '0136_contribute_share',
  '0137_contribute_hub',
  '0138_calendar',
  '0139_contact_history',
  '0140_calendar_proposals',
  '0141_mail_domain_adopted',
  '0142_inbox_labels',
  '0143_durable_conversation_user_title',
  '0144_contact_pipeline',
  '0145_contact_next_up',
  '0146_dashboard_hidden_tiles',
  '0147_kernel_approval_consumed',
  '0148_drive_file_content_date',
  '0149_company_logo_original',
  '0150_contact_sharing',
  '0151_message_reply_to',
  '0152_call_guest_invites',
  '0153_brand_social_posts',
  '0154_calendar_week_numbers',
  '0155_managed_mail_sender',
  '0156_message_voice_recordings',
  '0157_call_transcripts',
  '0158_assigned_tasks',
  '0159_call_brain',
  '0160_company_ai',
  '0161_repo_files',
  '0162_drive_source_key_prefix',
  '0163_reminders',
  '0164_memory_sharing',
  '0165_website_services_drop_host',
  '0166_open_join',
  '0167_member_daily_ai_cap',
  '0168_company_export',
  '0169_call_chat',
  '0170_ai_coworkers',
  '0171_coworker_thoughts',
  '0172_coworker_turns',
  '0173_coworker_proactive',
  '0174_coworker_delegation',
  '0175_decision_log',
  '0176_coworker_event_reactions',
  '0177_coworker_event_routes',
])

export const MARKERS = Object.freeze({
  contract: '-- ee:contract',
  noTransaction: '-- ee:no-transaction',
})

const MOVE_TO_CONTRACT =
  'the previous release still runs against this schema (blue/green, rollback) — move it to a later `-- ee:contract` migration once no released app reads it'

// ── tokenizer ────────────────────────────────────────────────────────────────

const WORD_START = /[A-Za-z_\u0080-￿]/
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/
const DIGIT = /[0-9]/
const OP_CHARS = '+-*/<>=~!@#%^&|`?'
const PUNCT = ';(),[].:'

function lineIndex(sql) {
  const starts = [0]
  for (let i = 0; i < sql.length; i++) if (sql[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * Postgres lexical tokens. Types: word (value lower-cased), qident (value unescaped), string,
 * dollar (value = body), param, number, op, punct, comment. Throws on an unterminated token.
 * @param {string} sql
 * @param {number} [lineOffset] added to every token's line (for a DO body inside a file)
 */
export function tokenize(sql, lineOffset = 0) {
  const lineAt = lineIndex(sql)
  const tokens = []
  const n = sql.length
  let i = 0
  const push = (type, start, end, value) =>
    tokens.push({
      type,
      text: sql.slice(start, end),
      value,
      start,
      end,
      line: lineAt(start) + lineOffset,
    })
  const fail = (what, start) => {
    throw new Error(`unterminated ${what} starting at line ${lineAt(start) + lineOffset}`)
  }
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const start = i
    if (c === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i)
      if (j === -1) j = n
      push('comment', start, j, sql.slice(start, j))
      i = j
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      if (depth > 0) fail('comment', start)
      push('comment', start, j, sql.slice(start, j))
      i = j
      continue
    }
    const escapeString = (c === 'E' || c === 'e') && sql[i + 1] === "'"
    if (c === "'" || escapeString) {
      let j = escapeString ? i + 2 : i + 1
      let value = ''
      for (;;) {
        if (j >= n) fail('string', start)
        const ch = sql[j]
        if (escapeString && ch === '\\') {
          value += sql.slice(j, j + 2)
          j += 2
          continue
        }
        if (ch === "'") {
          if (sql[j + 1] === "'") {
            value += "'"
            j += 2
            continue
          }
          j++
          break
        }
        value += ch
        j++
      }
      push('string', start, j, value)
      i = j
      continue
    }
    if (c === '"') {
      let j = i + 1
      let value = ''
      for (;;) {
        if (j >= n) fail('quoted identifier', start)
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            value += '"'
            j += 2
            continue
          }
          j++
          break
        }
        value += sql[j]
        j++
      }
      push('qident', start, j, value)
      i = j
      continue
    }
    if (c === '$') {
      if (DIGIT.test(sql[i + 1] ?? '')) {
        let j = i + 1
        while (j < n && DIGIT.test(sql[j])) j++
        push('param', start, j, sql.slice(start, j))
        i = j
        continue
      }
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 200))
      if (!m) throw new Error(`unexpected "$" at line ${lineAt(start) + lineOffset}`)
      const tag = m[0]
      const close = sql.indexOf(tag, i + tag.length)
      if (close === -1) fail(`dollar-quoted string ${tag}`, start)
      push('dollar', start, close + tag.length, sql.slice(i + tag.length, close))
      tokens[tokens.length - 1].bodyStart = i + tag.length
      i = close + tag.length
      continue
    }
    if (WORD_START.test(c)) {
      let j = i + 1
      while (j < n && WORD_PART.test(sql[j])) j++
      push('word', start, j, sql.slice(start, j).toLowerCase())
      i = j
      continue
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(sql[i + 1] ?? ''))) {
      let j = i + 1
      while (j < n && /[0-9.eE_]/.test(sql[j])) j++
      push('number', start, j, sql.slice(start, j))
      i = j
      continue
    }
    if (c === ':' && sql[i + 1] === ':') {
      push('op', start, i + 2, '::')
      i += 2
      continue
    }
    if (PUNCT.includes(c)) {
      push('punct', start, i + 1, c)
      i++
      continue
    }
    if (OP_CHARS.includes(c)) {
      let j = i + 1
      while (
        j < n &&
        OP_CHARS.includes(sql[j]) &&
        !(sql[j] === '-' && sql[j + 1] === '-') &&
        !(sql[j] === '/' && sql[j + 1] === '*')
      )
        j++
      push('op', start, j, sql.slice(start, j))
      i = j
      continue
    }
    throw new Error(
      `unexpected character ${JSON.stringify(c)} at line ${lineAt(start) + lineOffset}`,
    )
  }
  return tokens
}

/** Splits a token list (comments already removed) at depth-0 semicolons. */
function splitTokens(tokens) {
  const groups = []
  let current = []
  let depth = 0
  for (const t of tokens) {
    if (t.type === 'punct' && (t.value === '(' || t.value === '[')) depth++
    if (t.type === 'punct' && (t.value === ')' || t.value === ']')) depth--
    if (depth === 0 && t.type === 'punct' && t.value === ';') {
      if (current.length > 0) groups.push(current)
      current = []
      continue
    }
    current.push(t)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * The file's statements, without comments and without the closing semicolon.
 * @param {string} sql
 * @returns {{ text: string, line: number, tokens: any[] }[]}
 */
export function splitStatements(sql, lineOffset = 0) {
  const code = tokenize(sql, lineOffset).filter((t) => t.type !== 'comment')
  return splitTokens(code).map((tokens) => ({
    text: sql.slice(tokens[0].start, tokens[tokens.length - 1].end),
    line: tokens[0].line,
    tokens,
  }))
}

// ── markers ─────────────────────────────────────────────────────────────────

/**
 * The file's marker: 'contract', 'no-transaction' or null. Read from the first line only.
 * Throws on a first line that starts like a marker but is not one (a typo must not pass silently).
 */
export function migrationMarker(sql) {
  const first = sql.split(/\r?\n/, 1)[0].trim()
  if (first === MARKERS.contract) return 'contract'
  if (first === MARKERS.noTransaction) return 'no-transaction'
  if (/^--\s*ee:/.test(first)) {
    throw new Error(
      `unknown marker ${JSON.stringify(first)} on the first line: the markers are \`${MARKERS.contract}\` and \`${MARKERS.noTransaction}\``,
    )
  }
  return null
}

// ── statement analysis ──────────────────────────────────────────────────────

const kw = (t) => (t && t.type === 'word' ? t.value.toUpperCase() : null)
const isPunct = (t, v) => t && t.type === 'punct' && t.value === v
const isName = (t) => t && (t.type === 'word' || t.type === 'qident')
const nameValue = (t) => t.value

/** Reads a (schema-)qualified name at i; `public.` is dropped so `public.a` and `a` compare equal. */
function readName(t, i) {
  if (!isName(t[i])) return { name: null, next: i }
  const parts = [nameValue(t[i])]
  let j = i + 1
  while (isPunct(t[j], '.') && isName(t[j + 1])) {
    parts.push(nameValue(t[j + 1]))
    j += 2
  }
  if (parts.length > 1 && parts[0] === 'public') parts.shift()
  return { name: parts.join('.'), next: j }
}

function skipWords(t, i, ...words) {
  let j = i
  for (const w of words) {
    if (kw(t[j]) !== w) return i
    j++
  }
  return j
}

/** Splits tokens at depth-0 commas. */
function splitCommas(tokens) {
  const parts = []
  let current = []
  let depth = 0
  for (const t of tokens) {
    if (t.type === 'punct' && (t.value === '(' || t.value === '[')) depth++
    if (t.type === 'punct' && (t.value === ')' || t.value === ']')) depth--
    if (depth === 0 && isPunct(t, ',')) {
      parts.push(current)
      current = []
      continue
    }
    current.push(t)
  }
  if (current.length > 0) parts.push(current)
  return parts
}

/** Depth-0 tokens only (what is inside parentheses is a type argument, a default expression …). */
function topLevel(tokens) {
  const out = []
  let depth = 0
  for (const t of tokens) {
    if (t.type === 'punct' && (t.value === ')' || t.value === ']')) depth--
    if (depth === 0) out.push(t)
    if (t.type === 'punct' && (t.value === '(' || t.value === '[')) depth++
  }
  return out
}

const hasSequence = (tokens, ...words) =>
  tokens.some((_, i) => words.every((w, k) => kw(tokens[i + k]) === w))

const DROP_KINDS = [
  ['MATERIALIZED VIEW', 'view', 'drops a materialized view'],
  ['FOREIGN TABLE', 'table', 'drops a foreign table'],
  ['TABLE', 'table', 'drops a table'],
  ['VIEW', 'view', 'drops a view'],
  ['SCHEMA', null, 'drops a schema'],
  ['TYPE', 'type', 'drops a type'],
  ['DOMAIN', 'type', 'drops a domain'],
  ['SEQUENCE', null, 'drops a sequence'],
  ['FUNCTION', 'routine', 'drops a function'],
  ['PROCEDURE', 'routine', 'drops a procedure'],
  ['AGGREGATE', 'routine', 'drops an aggregate'],
  ['EXTENSION', null, 'drops an extension (and the types and functions it provides)'],
]

/** Views and routines may be dropped and re-created anywhere in the file; tables and types only after being created. */
const RECREATABLE = new Set(['view', 'routine'])

const TX_CONTROL = new Set([
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'START',
  'END',
  'SAVEPOINT',
  'RELEASE',
  'ABORT',
])
const SERIAL_TYPES = new Set([
  'SERIAL',
  'SERIAL2',
  'SERIAL4',
  'SERIAL8',
  'SMALLSERIAL',
  'BIGSERIAL',
])
const STATEMENT_STARTERS_IN_BODY = new Set(['THEN', 'ELSE', 'LOOP', 'BEGIN'])

/** What `CREATE …` makes: { kind, name } or null. */
function created(t) {
  if (kw(t[0]) !== 'CREATE') return null
  let i = skipWords(t, 1, 'OR', 'REPLACE')
  while (['TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'RECURSIVE'].includes(kw(t[i]))) i++
  let kind = null
  if (kw(t[i]) === 'TABLE') kind = 'table'
  else if (kw(t[i]) === 'TYPE' || kw(t[i]) === 'DOMAIN') kind = 'type'
  else if (kw(t[i]) === 'VIEW') kind = 'view'
  else if (kw(t[i]) === 'MATERIALIZED' && kw(t[i + 1]) === 'VIEW') {
    kind = 'view'
    i++
  } else if (['FUNCTION', 'PROCEDURE', 'AGGREGATE'].includes(kw(t[i]))) kind = 'routine'
  if (!kind) return null
  i = skipWords(t, i + 1, 'IF', 'NOT', 'EXISTS')
  const { name } = readName(t, i)
  return name ? { kind, name } : null
}

/** Every statement that runs at migration time: top-level ones and those inside DO blocks. */
function executedStatements(sql) {
  const out = []
  for (const stmt of splitStatements(sql)) {
    out.push({ ...stmt, topLevel: true })
    if (kw(stmt.tokens[0]) !== 'DO') continue
    const body = stmt.tokens.find((t) => t.type === 'dollar' || t.type === 'string')
    if (!body) continue
    const bodyText = body.value
    const bodyTokens = tokenize(bodyText, body.line - 1).filter((t) => t.type !== 'comment')
    for (const group of bodyStatements(bodyTokens)) {
      out.push({
        text: bodyText.slice(group[0].start, group[group.length - 1].end),
        line: group[0].line,
        tokens: group,
        topLevel: false,
      })
    }
  }
  return out
}

/** SQL statements inside a PL/pgSQL body: those that start after `;`, THEN, ELSE, LOOP or BEGIN. */
function bodyStatements(tokens) {
  const groups = []
  for (let i = 0; i < tokens.length; i++) {
    const prev = tokens[i - 1]
    const atStart = i === 0 || isPunct(prev, ';') || STATEMENT_STARTERS_IN_BODY.has(kw(prev))
    if (!atStart || !['DROP', 'ALTER', 'CREATE'].includes(kw(tokens[i]))) continue
    let depth = 0
    let j = i
    for (; j < tokens.length; j++) {
      const t = tokens[j]
      if (t.type === 'punct' && (t.value === '(' || t.value === '[')) depth++
      if (t.type === 'punct' && (t.value === ')' || t.value === ']')) depth--
      if (depth === 0 && isPunct(t, ';')) break
    }
    groups.push(tokens.slice(i, j))
    i = j
  }
  return groups
}

function analyzeDrop(t, ctx) {
  const match = DROP_KINDS.find(([words]) => skipWords(t, 1, ...words.split(' ')) !== 1)
  if (!match) return []
  const [words, kind, why] = match
  const i = skipWords(t, skipWords(t, 1, ...words.split(' ')), 'IF', 'EXISTS')
  const names = []
  for (const part of splitCommas(t.slice(i))) {
    const { name } = readName(part, 0)
    if (name) names.push(name)
  }
  const exempt = (name) =>
    kind !== null &&
    (RECREATABLE.has(kind) ? ctx.inFile[kind].has(name) : ctx.before[kind].has(name))
  return names.length > 0 && names.every(exempt) ? [] : [why]
}

function analyzeAlterTable(t, ctx, i) {
  i = skipWords(t, i, 'IF', 'EXISTS')
  i = skipWords(t, i, 'ONLY')
  const { name, next } = readName(t, i)
  if (!name) return []
  if (ctx.before.table.has(name)) return []
  let rest = t.slice(next)
  if (rest[0] && rest[0].type === 'op' && rest[0].value === '*') rest = rest.slice(1)
  const whys = []
  for (const action of splitCommas(rest)) {
    const a = topLevel(action)
    const a0 = kw(a[0])
    if (a0 === 'DROP') {
      if (kw(a[1]) !== 'CONSTRAINT') whys.push('drops a column')
    } else if (a0 === 'RENAME') {
      if (kw(a[1]) === 'TO') whys.push('renames a table')
      else if (kw(a[1]) !== 'CONSTRAINT') whys.push('renames a column')
    } else if (a0 === 'SET' && kw(a[1]) === 'SCHEMA') {
      whys.push('moves the table to another schema')
    } else if (a0 === 'ALTER') {
      let j = skipWords(a, 1, 'COLUMN')
      j = readName(a, j).next
      const tail = a.slice(j)
      if (kw(tail[0]) === 'TYPE' || hasSequence(tail.slice(0, 3), 'SET', 'DATA', 'TYPE'))
        whys.push("changes a column's type")
      else if (hasSequence(tail.slice(0, 3), 'SET', 'NOT', 'NULL'))
        whys.push("SET NOT NULL on an existing column (an older app's inserts may leave it empty)")
      else if (hasSequence(tail.slice(0, 2), 'DROP', 'DEFAULT'))
        whys.push("drops a column default (an older app's inserts rely on it)")
      else if (hasSequence(tail.slice(0, 2), 'DROP', 'IDENTITY'))
        whys.push("drops a column default: the identity (an older app's inserts rely on it)")
    } else if (a0 === 'ADD') {
      if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'EXCLUDE'].includes(kw(a[1])))
        continue
      let j = skipWords(a, 1, 'COLUMN')
      j = skipWords(a, j, 'IF', 'NOT', 'EXISTS')
      j = readName(a, j).next
      const def = a.slice(j)
      const notNull = hasSequence(def, 'NOT', 'NULL') || hasSequence(def, 'PRIMARY', 'KEY')
      const defaulted =
        def.some((x) => kw(x) === 'DEFAULT' || kw(x) === 'GENERATED') ||
        SERIAL_TYPES.has(kw(def[0]))
      if (notNull && !defaulted)
        whys.push(
          "adds a NOT NULL column without a default to an existing table (an older app's inserts don't set it)",
        )
    }
  }
  return whys
}

function analyzeAlterType(t, i) {
  const { name, next } = readName(t, i)
  if (!name) return []
  const a = t.slice(next)
  const head = (...w) => hasSequence(a.slice(0, w.length), ...w)
  if (head('RENAME', 'VALUE')) return ['renames an enum value']
  if (head('RENAME', 'TO')) return ['renames a type']
  if (head('RENAME', 'ATTRIBUTE')) return ['renames a type attribute']
  if (head('DROP', 'VALUE')) return ['drops an enum value']
  if (head('SET', 'SCHEMA')) return ['moves the type to another schema']
  const whys = []
  for (const action of splitCommas(a)) {
    if (hasSequence(action.slice(0, 1), 'DROP')) whys.push('drops a type attribute')
    else if (hasSequence(action.slice(0, 1), 'ALTER') && action.some((x) => kw(x) === 'TYPE'))
      whys.push("changes a type attribute's type")
  }
  return whys
}

const ALTER_OTHER = [
  ['MATERIALIZED VIEW', 'materialized view'],
  ['VIEW', 'view'],
  ['SEQUENCE', 'sequence'],
  ['FUNCTION', 'function'],
  ['PROCEDURE', 'procedure'],
  ['SCHEMA', 'schema'],
  ['DOMAIN', 'domain'],
]

/** Why a statement breaks an older app on the new schema ([] when it does not). */
function destructiveWhys(t, ctx) {
  const k0 = kw(t[0])
  if (k0 === 'DROP') return analyzeDrop(t, ctx)
  if (k0 !== 'ALTER') return []
  if (kw(t[1]) === 'TABLE') return analyzeAlterTable(t, ctx, 2)
  if (kw(t[1]) === 'FOREIGN' && kw(t[2]) === 'TABLE') return analyzeAlterTable(t, ctx, 3)
  if (kw(t[1]) === 'TYPE') return analyzeAlterType(t, 2)
  const other = ALTER_OTHER.find(([words]) => skipWords(t, 1, ...words.split(' ')) !== 1)
  if (!other) return []
  const top = topLevel(t)
  if (top.some((x) => kw(x) === 'RENAME')) return [`renames a ${other[1]}`]
  if (hasSequence(top, 'SET', 'SCHEMA')) return [`moves the ${other[1]} to another schema`]
  if (other[1] === 'domain' && hasSequence(top, 'SET', 'NOT', 'NULL'))
    return ['SET NOT NULL on an existing domain']
  return []
}

/** Statements that cannot run inside a transaction block — the only ones a `-- ee:no-transaction` file may hold. */
function needsNoTransaction(t) {
  const k0 = kw(t[0])
  if (k0 === 'CREATE') {
    const i = skipWords(t, 1, 'UNIQUE')
    return kw(t[i]) === 'INDEX' && kw(t[i + 1]) === 'CONCURRENTLY'
  }
  if (k0 === 'DROP') return kw(t[1]) === 'INDEX' && kw(t[2]) === 'CONCURRENTLY'
  if (k0 === 'REINDEX') return topLevel(t).some((x) => kw(x) === 'CONCURRENTLY')
  if (k0 === 'ALTER' && kw(t[1]) === 'TYPE') {
    const { next } = readName(t, 2)
    return kw(t[next]) === 'ADD' && kw(t[next + 1]) === 'VALUE'
  }
  return false
}

const NO_TRANSACTION_WHY =
  'may not run outside a transaction: a `-- ee:no-transaction` file holds only statements that cannot run inside one (CREATE/DROP INDEX CONCURRENTLY, REINDEX … CONCURRENTLY, ALTER TYPE … ADD VALUE) — move it to an ordinary migration'

const oneLine = (text) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat
}

function finding(file, line, statement, why, fix) {
  const shown = oneLine(statement)
  return {
    file,
    line,
    statement: shown,
    why,
    message: `${file}:${line}: ${shown}\n    ${why}${fix ? ` — ${fix}` : ''}`,
  }
}

/**
 * @param {{ entries: { tag: string, sql: string }[], baselined: Set<string> }} input
 * @returns {{ file: string, line: number, statement: string, why: string, message: string }[]}
 */
export function lintMigrations({ entries, baselined }) {
  const findings = []
  for (const { tag, sql } of entries) {
    const file = `drizzle/${tag}.sql`
    const firstLine = sql.split(/\r?\n/, 1)[0]
    let marker = null
    try {
      marker = migrationMarker(sql)
    } catch (err) {
      findings.push(finding(file, 1, firstLine, err.message))
    }
    let statements
    try {
      for (const c of tokenize(sql)) {
        if (c.type === 'comment' && c.line > 1 && /^--\s*ee:/.test(c.text))
          findings.push(
            finding(
              file,
              c.line,
              c.text,
              'a `-- ee:` marker must be the first line of the file, or it does nothing',
            ),
          )
      }
      statements = executedStatements(sql)
    } catch (err) {
      findings.push(finding(file, 1, firstLine, `cannot be parsed: ${err.message}`))
      continue
    }

    if (marker === 'no-transaction') {
      for (const s of statements.filter((x) => x.topLevel)) {
        if (!needsNoTransaction(s.tokens))
          findings.push(finding(file, s.line, s.text, NO_TRANSACTION_WHY))
      }
      continue
    }

    for (const s of statements.filter((x) => x.topLevel)) {
      const k0 = kw(s.tokens[0])
      if (TX_CONTROL.has(k0))
        findings.push(
          finding(
            file,
            s.line,
            s.text,
            'transaction control in a migration: scripts/migrate.mjs runs each file in its own transaction',
            'remove it (use `-- ee:no-transaction` for statements that cannot run in one)',
          ),
        )
    }

    if (marker === 'contract' || baselined.has(tag)) continue
    const ctx = {
      inFile: { table: new Set(), type: new Set(), view: new Set(), routine: new Set() },
      before: { table: new Set(), type: new Set(), view: new Set(), routine: new Set() },
    }
    for (const s of statements) {
      const c = created(s.tokens)
      if (c) ctx.inFile[c.kind].add(c.name)
    }
    for (const s of statements) {
      for (const why of destructiveWhys(s.tokens, ctx))
        findings.push(finding(file, s.line, s.text, why, MOVE_TO_CONTRACT))
      const c = created(s.tokens)
      if (c) ctx.before[c.kind].add(c.name)
    }
  }
  return findings
}

/**
 * How scripts/migrate.mjs runs a file. 'transaction': drizzle's breakpoint chunks, all in one
 * transaction with the bookkeeping row. 'no-transaction': single statements, one by one.
 * Throws (naming the file) on an unknown marker or a statement a no-transaction file may not hold.
 */
export function planMigration(sql, tag) {
  let marker
  try {
    marker = migrationMarker(sql)
  } catch (err) {
    throw new Error(`drizzle/${tag}.sql: ${err.message}`, { cause: err })
  }
  if (marker !== 'no-transaction') {
    return {
      mode: 'transaction',
      statements: sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    }
  }
  const statements = splitStatements(sql)
  for (const s of statements) {
    if (!needsNoTransaction(s.tokens))
      throw new Error(`drizzle/${tag}.sql:${s.line}: ${oneLine(s.text)} — ${NO_TRANSACTION_WHY}`)
  }
  return { mode: 'no-transaction', statements: statements.map((s) => s.text) }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../drizzle')

function runLint() {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf-8'),
  )
  const tags = new Set(journal.entries.map((e) => e.tag))
  const stale = BASELINED_MIGRATIONS.filter((t) => !tags.has(t))
  if (stale.length > 0) {
    console.error(
      `migration lint: baselined migrations missing from the journal: ${stale.join(', ')}`,
    )
    process.exit(1)
  }
  const entries = journal.entries.map((e) => ({
    tag: e.tag,
    sql: readFileSync(path.join(migrationsFolder, `${e.tag}.sql`), 'utf-8'),
  }))
  const findings = lintMigrations({ entries, baselined: new Set(BASELINED_MIGRATIONS) })
  if (findings.length > 0) {
    console.error(`migration lint: ${findings.length} finding(s)\n`)
    for (const f of findings) console.error(`${f.message}\n`)
    process.exit(1)
  }
  console.log(
    `migration lint: ${entries.length} migrations clean (${BASELINED_MIGRATIONS.length} baselined through ${BASELINED_MIGRATIONS.at(-1)})`,
  )
}

/** The database diagnostic (unchanged behaviour): migration state and schema completeness. */
async function diagnose() {
  await import('./load-env.mjs')
  const { createHash } = await import('node:crypto')
  const { default: postgres } = await import('postgres')
  const { getDatabaseUrl } = await import('./db-urls.mjs')
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf-8'),
  )
  const migrationHash = (sqlContent) => createHash('sha256').update(sqlContent).digest('hex')
  const sql = postgres(getDatabaseUrl(), { max: 1 })

  try {
    console.log('=== Migration State Check ===\n')

    // Check if drizzle schema exists
    const [{ exists: drizzleSchemaExists }] = await sql`
  		SELECT EXISTS (
  			SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle'
  		) AS exists
  	`
    console.log(`Drizzle schema exists: ${drizzleSchemaExists}`)

    // Check migration tracking table
    const [{ exists: migrationsTableExists }] = await sql`
  		SELECT EXISTS (
  			SELECT 1 FROM information_schema.tables
  			WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
  		) AS exists
  	`
    console.log(`Migration tracking table exists: ${migrationsTableExists}`)

    let appliedMigrations = []
    if (migrationsTableExists) {
      appliedMigrations =
        await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
      console.log(`Applied migrations: ${appliedMigrations.length}`)
    }

    // Check each migration
    console.log('\n=== Migration Status ===\n')
    const appliedHashes = new Set(appliedMigrations.map((r) => r.hash))
    let missingCount = 0

    for (const entry of journal.entries) {
      const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`)
      const sqlContent = readFileSync(sqlPath, 'utf-8')
      const hash = migrationHash(sqlContent)
      const isApplied = appliedHashes.has(hash)

      if (!isApplied) {
        console.log(`❌ ${entry.tag} (idx ${entry.idx}) - NOT APPLIED`)
        missingCount++
      }
    }

    if (missingCount === 0) {
      console.log('✅ All migrations are applied')
    } else {
      console.log(`\n⚠️  ${missingCount} migration(s) need to be applied`)
    }

    // Check thought table schema
    console.log('\n=== Thought Table Schema ===\n')
    const thoughtColumns = await sql`
  		SELECT column_name, data_type, is_nullable
  		FROM information_schema.columns
  		WHERE table_schema = 'public' AND table_name = 'thought'
  		ORDER BY ordinal_position
  	`
    console.log(`Thought table has ${thoughtColumns.length} columns:`)
    for (const col of thoughtColumns) {
      console.log(
        `  - ${col.column_name} (${col.data_type}, ${col.is_nullable === 'YES' ? 'nullable' : 'NOT NULL'})`,
      )
    }

    // Check required columns
    const requiredColumns = [
      'id',
      'user_id',
      'raw_text',
      'normalized_text',
      'lexical_text',
      'category',
      'metadata',
      'embedding',
      'created_at',
      'updated_at',
      'raw_text_encrypted',
      'normalized_text_encrypted',
      'metadata_encrypted',
      'ontology_entity_kind_id',
      'memory_type',
      'cues',
      'cues_encrypted',
      'salience_score',
      'access_count',
      'last_accessed_at',
      'enriched_at',
      'enrich_queue_status',
      'enrich_queue_error',
      'capture_source',
      'enrichment_version',
      'rerank_snippet',
      'primary_community_ids',
      'entity_centrality_max',
      'specificity_score',
      'recency_bucket',
      'bundle_rank',
    ]
    const existingColumns = new Set(thoughtColumns.map((c) => c.column_name))
    const missingColumns = requiredColumns.filter((c) => !existingColumns.has(c))

    if (missingColumns.length > 0) {
      console.log(`\n❌ Missing columns: ${missingColumns.join(', ')}`)
    } else {
      console.log('\n✅ All required columns exist')
    }

    // Check AGE graph
    console.log('\n=== Apache AGE Graph ===\n')
    try {
      await sql.unsafe(`LOAD 'age'`)
      await sql.unsafe(`SET search_path = ag_catalog, public`)
      const graphName = process.env.AGE_GRAPH_NAME?.trim() || 'eigen_graph'
      const [{ exists: graphExists }] = await sql`
  			SELECT EXISTS (
  				SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${graphName}
  			) AS exists
  		`
      console.log(`Graph '${graphName}' exists: ${graphExists}`)
    } catch (err) {
      console.log(`AGE check failed: ${err.message}`)
    }

    // Check eigen_app role
    console.log('\n=== eigen_app Role ===\n')
    const [{ exists: roleExists }] = await sql`
  		SELECT EXISTS (
  			SELECT 1 FROM pg_roles WHERE rolname = 'eigen_app'
  		) AS exists
  	`
    console.log(`eigen_app role exists: ${roleExists}`)

    if (roleExists) {
      const grants = await sql`
  			SELECT grantee, privilege_type, table_schema
  			FROM information_schema.role_table_grants
  			WHERE grantee = 'eigen_app' AND table_schema = 'public'
  			LIMIT 5
  		`
      console.log(`eigen_app has ${grants.length} grants on public schema`)
    }
  } catch (err) {
    console.error('Error:', err.message)
  } finally {
    await sql.end()
  }
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const command = process.argv[2]
  if (command === 'lint') runLint()
  else if (command === undefined) await diagnose()
  else {
    console.error('usage: node scripts/check-migrations.mjs [lint]')
    process.exit(2)
  }
}
