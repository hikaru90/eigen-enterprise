/**
 * Handover records (migration 0184, plan/handover.md): a company-level page a
 * member keeps for a person or a topic — "Handover to Alex" — one entry per
 * topic, each a date, a topic, one sentence, a status and a link to the detail.
 * Company-level tables (no RLS), like assigned tasks: every member reads every
 * handover; only its owner writes (the service decides).
 */

export const HANDOVER_STATUSES = ['decision_needed', 'in_progress', 'for_info'] as const
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number]

/** Who wrote an entry: the owner, their assistant on their word, or the brain's upkeep (handover.draft_entry). */
export const HANDOVER_ENTRY_VIAS = ['person', 'assistant', 'brain'] as const
export type HandoverEntryVia = (typeof HANDOVER_ENTRY_VIAS)[number]

export type Handover = {
  id: string
  ownerId: string
  title: string
  /** The person the handover is for (a member id); null = a topic handover. */
  subjectId: string | null
  createdAt: Date
  updatedAt: Date
}

export type HandoverEntry = {
  id: string
  handoverId: string
  /** The day the entry speaks for (YYYY-MM-DD). */
  entryOn: string
  topic: string
  sentence: string
  status: HandoverStatus
  /** An app path (/m/…) or an http(s) URL to the detail document or item; null = none. */
  link: string | null
  /** The member it is assigned to; null = for information only. */
  assigneeId: string | null
  /** The assigned task that carries it into the assignee's Needs you. */
  assignedTaskId: string | null
  writtenVia: HandoverEntryVia
  createdAt: Date
  updatedAt: Date
}

export type HandoverEntryPatch = Partial<
  Pick<HandoverEntry, 'entryOn' | 'topic' | 'sentence' | 'status' | 'link' | 'assigneeId' | 'assignedTaskId' | 'writtenVia' | 'updatedAt'>
>

export type HandoverStore = {
  insertHandover(h: Handover): Promise<void>
  getHandover(id: string): Promise<Handover | null>
  /** Every handover, most recently changed first. */
  listHandovers(): Promise<Handover[]>
  touchHandover(id: string, at: Date): Promise<void>
  /** Fails with HandoverTopicTakenError when the handover already has an entry on that topic. */
  insertEntry(e: HandoverEntry): Promise<void>
  getEntry(id: string): Promise<HandoverEntry | null>
  /** The entry on this topic (same words, case and outer spaces aside), if any. */
  entryByTopic(handoverId: string, topic: string): Promise<HandoverEntry | null>
  /** The entries of these handovers, newest first (entry day, then last change). */
  listEntries(handoverIds: readonly string[]): Promise<HandoverEntry[]>
  /** Null when the entry is gone; HandoverTopicTakenError when the new topic is taken. */
  updateEntry(id: string, patch: HandoverEntryPatch): Promise<HandoverEntry | null>
  deleteEntry(id: string): Promise<boolean>
  /** Removes the handover and (cascade) its entries. False when it was already gone. */
  deleteHandover(id: string): Promise<boolean>
}

/** A store-level refusal: the handover already has an entry on that topic (one entry per topic). */
export class HandoverTopicTakenError extends Error {
  constructor(readonly topic: string) {
    super(`This handover already has an entry on "${topic}".`)
    this.name = 'HandoverTopicTakenError'
  }
}

/** The identity of a topic (structure, not meaning): the same words, whatever the case or outer spaces. */
export const topicKey = (topic: string) => topic.trim().toLowerCase()
