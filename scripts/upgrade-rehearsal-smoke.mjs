/**
 * The previous release's read smoke (plan/phase-upgrades.md §7 "Core schema"):
 * the read tools the rehearsal calls, as the demo owner, from the PREVIOUS
 * release's own code — once on its own schema (the baseline) and again after
 * this tree's migrations. During blue/green the old app keeps serving these
 * reads on the new schema; any that breaks is an upgrade that is not
 * expand-only.
 *
 * The list is explicit and lives only here. It covers the core data every
 * box has and the demo seed fills (members, contacts, projects and tasks,
 * channels and messages, calendar, Drive, website, brand, settings, the
 * kernel). It leaves out reads that reach outside the database (GitHub, the
 * hub, ee's socket, owlery, DNS) or call a model (memory.retrieve_thoughts):
 * they cannot tell a schema break from a missing network.
 *
 * Entries run in order. `input` is the tool's input, or a function of the
 * outputs so far, keyed by `as` or the tool name (a get uses an id a list
 * returned). kernel.whoami is left out: it reports the AI provider's status,
 * which a rehearsal without a provider cannot answer. This file is copied into
 * the previous release's checkout with scripts/upgrade-rehearsal-release.ts,
 * so it imports nothing.
 */

/** @typedef {Record<string, unknown>} SmokeOutputs */
/**
 * `as` names the entry (and its output) when one tool is called twice.
 * @typedef {{ tool: string, as?: string, input: object | ((outputs: SmokeOutputs) => object) }} SmokeItem
 */

/**
 * The first element of the array at `key` in an earlier read's output (or of
 * the output itself when `key` is null), failing loud when there is none: a
 * get with nothing to get is no smoke.
 * @param {SmokeOutputs} outputs @param {string} from the earlier entry's name
 * @param {string | null} key @param {string} field
 */
export function first(outputs, from, key, field) {
  if (!(from in outputs)) throw new Error(`not run: it reads an id from ${from}, which failed`)
  const output = outputs[from]
  const list = key === null ? output : /** @type {Record<string, unknown>} */ (output ?? {})[key]
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`nothing to read: ${from} returned no ${key ?? 'items'} (was the demo seeded?)`)
  }
  const value = list[0]?.[field]
  if (value === undefined || value === null)
    throw new Error(`the first of ${from}'s ${key ?? 'items'} has no ${field}`)
  return value
}

/** @type {SmokeItem[]} */
export const SMOKE = [
  { tool: 'kernel.module_list', input: {} },
  // The demo seed approves its own gated calls: there are approved rows to list.
  { tool: 'kernel.approvals_list', input: { status: 'approved' } },
  { tool: 'settings.get', input: {} },
  { tool: 'demo.status', input: {} },
  { tool: 'members.list', input: {} },
  { tool: 'members.group_list', input: {} },
  { tool: 'contacts.list', input: {} },
  { tool: 'contacts.get', input: (o) => ({ id: first(o, 'contacts.list', 'contacts', 'id') }) },
  { tool: 'contacts.pipeline', input: {} },
  { tool: 'contacts.follow_ups', input: {} },
  { tool: 'memory.list_projects', input: {} },
  {
    tool: 'memory.get_project_timeline',
    input: (o) => ({ project_entity_id: first(o, 'memory.list_projects', 'projects', 'entityId') }),
  },
  { tool: 'memory.list_tasks', input: {} },
  { tool: 'memory.list_text_files', input: {} },
  { tool: 'tasks.list', input: {} },
  { tool: 'tasks.assignees', input: {} },
  { tool: 'reminders.list', input: {} },
  { tool: 'messages.list_channels', input: {} },
  {
    tool: 'messages.read',
    input: (o) => ({ conversation_id: first(o, 'messages.list_channels', 'conversations', 'id') }),
  },
  { tool: 'calendar.list', input: {} },
  { tool: 'drive.list', input: {} },
  // The demo's documents sit in one company folder at the root.
  {
    tool: 'drive.list',
    as: 'drive.list (company folder)',
    input: (o) => ({ folder_id: first(o, 'drive.list', 'items', 'id') }),
  },
  {
    tool: 'drive.read',
    input: (o) => ({ file_id: first(o, 'drive.list (company folder)', 'items', 'id') }),
  },
  { tool: 'website.list_pages', input: {} },
  {
    tool: 'website.get_page',
    input: (o) => ({ slug: first(o, 'website.list_pages', null, 'slug') }),
  },
  { tool: 'website.site_info', input: {} },
  { tool: 'brand.set_list', input: {} },
  { tool: 'coworkers.list', input: {} },
  { tool: 'org.chart', input: {} },
  { tool: 'email.template_list', input: {} },
  { tool: 'calls.list', input: {} },
  { tool: 'notifications.settings_get', input: {} },
]

/**
 * A stable digest of a read's output — its shape and how many items each list
 * holds — so the old app's reads before and after the migrations can be
 * compared: same counts, same top-level fields. Values themselves are left
 * out (timestamps, relative dates).
 * @param {unknown} output
 * @returns {string}
 */
export function summarize(output) {
  if (Array.isArray(output)) return `${output.length} items`
  if (output === null || typeof output !== 'object') return typeof output
  return Object.keys(output)
    .sort()
    .map((k) => {
      const v = /** @type {Record<string, unknown>} */ (output)[k]
      return Array.isArray(v) ? `${k}[${v.length}]` : k
    })
    .join(' ')
}
