/**
 * Calls domain types and the storage seam (Postgres in db-store.ts,
 * in-memory in memory-store.ts for tests). Tables: `call`, `call_participant`
 * (drizzle/0122_calls.sql).
 */

export const CALL_CONTEXT_KINDS = ['dm', 'channel', 'meeting'] as const
export type CallContextKind = (typeof CALL_CONTEXT_KINDS)[number]

export const CALL_STATES = ['ringing', 'active', 'ended', 'missed', 'declined'] as const
export type CallState = (typeof CALL_STATES)[number]

export const CALL_RESPONSES = ['accepted', 'declined', 'none'] as const
export type CallResponse = (typeof CALL_RESPONSES)[number]

export type Call = {
  id: string
  /** The LiveKit room (unique). */
  roomName: string
  contextKind: CallContextKind
  /** The DM/channel conversation id; null for a meeting. */
  contextId: string | null
  title: string
  /** A person's user id, or the agent principal that started a meeting. */
  startedBy: string
  state: CallState
  startedAt: Date
  endedAt: Date | null
}

export type Participant = {
  callId: string
  userId: string
  invitedAt: Date
  /** First time LiveKit saw them in the room (webhook), null until then. */
  joinedAt: Date | null
  /** Set when they leave; cleared when they rejoin. */
  leftAt: Date | null
  response: CallResponse
}

export type CallRecord = { call: Call; participants: Participant[] }

/** A second live call for the same DM/channel loses: the caller gets the existing one. */
export type InsertResult = { ok: true } | { ok: false; existing: CallRecord | null }

export type CallsStore = {
  /** Refused (ok: false) only when the context already has a live (ringing/active) call. */
  insert(rec: CallRecord): Promise<InsertResult>
  get(id: string): Promise<CallRecord | null>
  getByRoom(roomName: string): Promise<CallRecord | null>
  liveForContext(kind: CallContextKind, contextId: string): Promise<CallRecord | null>
  /** Calls the person was part of, newest first. */
  listForUser(userId: string, limit: number): Promise<CallRecord[]>
  /** Calls a principal started, newest first. */
  listStartedBy(principalId: string, limit: number): Promise<CallRecord[]>
  /** Ringing/active calls the person is part of. */
  liveForUser(userId: string): Promise<CallRecord[]>
  /** Ids of calls still ringing that started at or before `cutoff`. */
  ringingStartedBefore(cutoff: Date): Promise<string[]>
  /**
   * Locks the call, applies `change` to its current record and stores the
   * result when it differs (then wakes every listening process). A throw in
   * `change` stores nothing. Null when the call does not exist.
   */
  mutate(id: string, change: (rec: CallRecord) => CallRecord): Promise<{ before: CallRecord; after: CallRecord } | null>
}

export type CallPerson = { id: string; name: string; email: string }

/** The company's people (display names) and their roles; null role = not a member. */
export type CallsDirectory = {
  listPeople(): Promise<CallPerson[]>
  role(userId: string): Promise<'owner' | 'admin' | 'member' | null>
}
