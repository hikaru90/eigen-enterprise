/**
 * The tool-level baseline of the north-star eval, measured 2026-11-20 at
 * CB0 (no model involved). The unit gate (static.pg.spec.ts) asserts the
 * product matches it EXACTLY, so it works as a ratchet like CB4's debt list:
 *
 * - a NEW leak, or a Knows source that stops being reachable, fails the gate;
 * - FIXING a leak (or making a source reachable) also fails it until the
 *   entry is removed here — the list may only shrink / grow toward the concept,
 *   and every change to it is visible in review.
 *
 * Entries are `member ← fixture source` (see fixture/company.ts).
 */

/** Content reaching someone the concept says may not read it. */
export const KNOWN_TOOL_LEAKS: readonly string[] = [
  // CB3 (2026-11-20): the brain reads Drive as the person, so members no longer get others' private files.
  // What is left is the person's own Drive rights: the owner and admins can open every member's private
  // files (modules/drive/service.ts allows(); no admin override in the concept — open, the orchestrator decides).
  'martin ← drive-ony-salary',
  'martin ← drive-priya-onboarding',
  'ony ← drive-priya-onboarding',
  // contacts: an admin sees everyone's unshared contacts (no admin override in the concept)
  'ony ← ct-elin',
]

/**
 * Knows items whose every source the asker's tools can reach today. CB3 added K15–K18
 * (own Memory thoughts, own DMs and private channels, read as the person) and
 * reaches shared Drive files through drive.shared_with_me: K05–K08/K19 kept, K02–K04
 * (the shared pitch deck, now readable with the PPTX text extraction) added.
 */
export const KNOWN_REACHABLE_KNOWS: readonly string[] = [
  'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08', 'K09', 'K10', 'K11', 'K12', 'K14', 'K15', 'K16', 'K17', 'K18', 'K19',
]
