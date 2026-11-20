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
  // drive.read/drive.list run as the agent principal, which Drive lets see every file (modules/drive/service.ts allows(): agent → true)
  'martin ← drive-ony-salary',
  'martin ← drive-priya-onboarding',
  'ony ← drive-priya-onboarding',
  'priya ← drive-acme-proposal',
  'priya ← drive-ony-salary',
  'jonas ← drive-acme-proposal',
  'jonas ← drive-ony-salary',
  'jonas ← drive-priya-onboarding',
  // contacts: an admin sees everyone's unshared contacts (no admin override in the concept)
  'ony ← ct-elin',
]

/** Knows items whose every source the asker's tools can reach today. */
export const KNOWN_REACHABLE_KNOWS: readonly string[] = ['K05', 'K06', 'K07', 'K08', 'K09', 'K10', 'K11', 'K12', 'K14', 'K19']
