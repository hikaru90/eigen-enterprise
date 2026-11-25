import { accountabilityLines } from '$lib/coworkers/org-tree'
import { field } from './page-actions'

/**
 * What the co-worker and seat forms post, read into the tools' input — one
 * reader for every page that hosts them (/coworkers, Settings → Co-workers,
 * Settings → Org chart), so a field a form adds reaches the tool on all of
 * them (fc3c5174: /coworkers kept its own copy and dropped the multi-select
 * reports-to and the avatar while Save answered "done").
 */

/** Reports-to as the forms post it: the multi-select (reports_to_sent + reports_to_user_ids) or a single reports_to_user_id ('' = nobody). */
export function reportsToInput(form: FormData): Record<string, unknown> {
  if (form.has('reports_to_sent')) {
    return {
      reports_to_user_ids: form
        .getAll('reports_to_user_ids')
        .map(String)
        .filter((s) => s.trim() !== ''),
    }
  }
  if (form.has('reports_to_user_id')) return { reports_to_user_id: field(form, 'reports_to_user_id') || null }
  return {}
}

/** The role card fields as coworkers.create / coworkers.update take them; an empty field is left out (the template's or the current value stays). */
export function cardInput(form: FormData, mode: 'create' | 'update'): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['name', 'title', 'lens', 'model_id'] as const) {
    const v = field(form, key).trim()
    if (v !== '') out[key] = v
  }
  if (form.has('accountabilities')) out.accountabilities = accountabilityLines(field(form, 'accountabilities'))
  Object.assign(out, reportsToInput(form))
  const preset = field(form, 'avatar_preset').trim()
  const sha = field(form, 'avatar_sha256').trim()
  if (preset !== '') {
    out.avatar_preset = preset
  } else if (sha !== '') {
    out.avatar_sha256 = sha
  } else if (mode === 'update' && form.has('avatar_sent')) {
    out.avatar_preset = null
    out.avatar_sha256 = null
  }
  const cap = field(form, 'daily_cap_usd').trim()
  if (cap !== '') out.daily_cap_usd = Number(cap)
  return out
}

/** A seat as org.set_position takes it; reports-to only when the form shows it (owner and admins). */
export function seatInput(form: FormData): Record<string, unknown> {
  const title = field(form, 'title').trim()
  return {
    user_id: field(form, 'user_id'),
    title: title === '' ? null : title,
    accountabilities: accountabilityLines(field(form, 'accountabilities')),
    ...reportsToInput(form),
  }
}
