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
  // C8 (2026-11-23), seen once the fixture had a private channel without Ony (#launch): an admin
  // reads a private channel she is not in (messages.read; no admin override in the concept).
  'ony ← msg-launch-brief',
  // C8 FINDING (2026-11-23): an AI co-worker reads EVERY Drive file — private ones and ones shared with
  // others only — directly and through `ee`. modules/drive/tools.ts actorOf() maps every non-human
  // principal to the Drive actor { kind: 'agent' }, which Drive treats as company-level; a co-worker
  // must be { kind: 'user', userId: <its id> } like a member (plan/phase-ai-coworkers.md §2). Product
  // change, not the eval's: strike these when Drive opts co-workers in as members.
  'marketing ← drive-acme-proposal',
  'marketing ← drive-ony-salary',
  'marketing ← drive-priya-onboarding',
  'gtm ← drive-acme-proposal',
  'gtm ← drive-ony-salary',
  'gtm ← drive-priya-onboarding',
  'designer ← drive-acme-proposal',
  'designer ← drive-ony-salary',
  'designer ← drive-priya-onboarding',
]

/**
 * Knows items whose every source the asker's tools can reach today. CB3 added K15–K18
 * (own Memory thoughts, own DMs and private channels, read as the person) and
 * reaches shared Drive files through drive.shared_with_me: K05–K08/K19 kept, K02–K04
 * (the shared pitch deck, now readable with the PPTX text extraction) added. C8 crawls the
 * mailboxes too (email.mailbox_list → mail_list → mail_read): K13 (the sales mailbox) added.
 */
export const KNOWN_REACHABLE_KNOWS: readonly string[] = [
  'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08', 'K09', 'K10', 'K11', 'K12', 'K13', 'K14', 'K15', 'K16', 'K17', 'K18', 'K19',
]

// ── AI co-workers (C8, plan/phase-ai-coworkers.md) ──────────────────────────

/**
 * Co-workers / Keeps leak tests that FAIL today, measured 2026-11-23 (ratchet, like
 * KNOWN_TOOL_LEAKS): CK05 drive-private and CK06 drive-shared-with-some — every co-worker
 * reads every Drive file (the Drive actor finding above). All other leak tests, the reach
 * tests and the read-only checks pass.
 */
export const COWORKER_KEEPS_FAILING: readonly string[] = ['CK05', 'CK06']

/** Co-workers / Does checks against the scripted model, measured 2026-11-23: all seven pass. */
export const COWORKER_DOES_PASSING: readonly string[] = ['CD01', 'CD02', 'CD03', 'CD04', 'CD05', 'CD06', 'CD07']

/**
 * Different (real models only): the three co-workers' answers to the same open
 * question pass when no two are closer than this cosine similarity of their
 * embeddings (the install's embedding model, through the gateway). Chosen at
 * C8 (2026-11-23) before any real-model run: set it to the measured value on
 * the first per-release run. Jev's "do these take distinct positions?" is the
 * TODO slot `different.jevJudge` (CB2), not a replacement for this.
 */
export const DIFFERENT_MAX_PAIRWISE_COSINE = 0.9
