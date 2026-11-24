/**
 * Single timeline lifecycle client for every surface.
 *
 * Surfaces (Tasks today, Projects grouping, project detail page, unassigned
 * bucket) only decide *where* a row is rendered. Mark done / reopen / archive
 * always goes through {@link postTimelineQuickAction} →
 * `POST /api/temporal-events/:id/action`. Project assignment is irrelevant.
 */

import type { TemporalEventListItem } from '../api/temporal-events/+server'
import { requestErrorOf } from '$lib/memory/request-error'

export type TimelineQuickAction = 'mark_done' | 'reopen' | 'archive'

export type TimelineQuickActionResult = {
  item: TemporalEventListItem
  summary: string
}

/** Surfaces that must share {@link postTimelineQuickAction} (regression contract). */
export const TIMELINE_QUICK_ACTION_SURFACES = [
  'tasks_today',
  'projects_unassigned',
  'projects_detail',
  'capture_recent',
] as const

export type TimelineQuickActionSurface = (typeof TIMELINE_QUICK_ACTION_SURFACES)[number]

export function timelineQuickActionRequestUrl(itemId: string): string {
  const id = itemId.trim()
  if (!id) {
    throw new Error('Timeline item id is required')
  }
  return `/api/temporal-events/${encodeURIComponent(id)}/action`
}

export function timelineQuickActionRequestBody(action: TimelineQuickAction): {
  action: TimelineQuickAction
} {
  return { action }
}

/** Inverse lifecycle action for one-click Undo after marking done or reopening. */
export function inverseTimelineQuickAction(
  action: TimelineQuickAction,
): 'mark_done' | 'reopen' | null {
  if (action === 'mark_done') return 'reopen'
  if (action === 'reopen') return 'mark_done'
  return null
}

/**
 * Mark done / reopen / archive for any timeline row id (`task:…` or event uuid).
 * Call this from every UI surface — do not fork PATCH /api/thoughts by view.
 * A refusal throws a `RequestError` (its `shown` carries the agent report).
 */
export async function postTimelineQuickAction(
  itemId: string,
  action: TimelineQuickAction,
  fetchImpl: typeof fetch = fetch,
): Promise<TimelineQuickActionResult> {
  const res = await fetchImpl(timelineQuickActionRequestUrl(itemId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(timelineQuickActionRequestBody(action)),
  })
  if (!res.ok) throw await requestErrorOf(res)
  return (await res.json()) as TimelineQuickActionResult
}
