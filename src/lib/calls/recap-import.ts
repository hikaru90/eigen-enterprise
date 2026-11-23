/**
 * The call recap into the brain (owner, 2026-11-23): "Import into the brain"
 * drafts a message into the assistant's composer (?prefill=, never sent by
 * itself). The person reads it, may add to it (typing or the mic) and sends
 * it; the assistant fetches the recap (calls.brain_recap), proposes what it
 * would save — notes in Memory, tasks (theirs or a colleague's), projects —
 * and saves only after the person's OK in the chat, with the tools anyone
 * can call (memory.capture_thought, memory.create_task, memory.create_project,
 * tasks.assign). No new write path: the CLI and the agent reach the same.
 *
 * The link carries the call's id and title only, never the recap's text: an
 * address can end up in logs.
 */

export type RecapCall = { id: string; title: string }

export function recapImportDraft(call: RecapCall): string {
  return (
    `Import the Company Brain recap of my call “${call.title}” (call ${call.id}) into my Memory. ` +
    'First list what you would save — notes, tasks (mine or for a colleague) and the project each belongs to — ' +
    'and wait for my OK before saving anything.'
  )
}

/**
 * `base`: '' on a page inside the app shell (the draft lands in the panel on
 * that page), '/' from the call's own tab (no shell there: it opens the app).
 */
export function recapImportHref(base: '' | '/', call: RecapCall): string {
  return `${base}?prefill=${encodeURIComponent(recapImportDraft(call))}`
}
