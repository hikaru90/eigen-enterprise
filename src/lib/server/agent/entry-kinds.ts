/**
 * Application entry kinds ee writes into pi-durable conversations (kinds must
 * not start with `pi.`). Shared by the harness (writer) and the run feed
 * projection (reader) — the feed reads them structurally, never by parsing
 * message text.
 */

/**
 * A user input composed from injected context plus the owner's own words:
 * the model message carries the composed text, `data.ownerText` the owner's
 * words (what run feeds show).
 */
export const OWNER_INPUT_ENTRY_KIND = 'ee.owner_input'
export type OwnerInputEntryData = { ownerText: string }

/** A turn that settled without an answer (display-only; the model never sees it). */
export const TURN_FAILED_ENTRY_KIND = 'ee.turn_failed'
export type TurnFailedEntryData = { reason: string; detail?: string }
