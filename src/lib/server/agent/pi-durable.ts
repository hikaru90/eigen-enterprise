/**
 * The ONE module that imports @earendil-works/pi-durable, @earendil-works/chord
 * and @earendil-works/pi-ai (plan/phase-durable.md D1): every other file in the
 * repo touches the durable harness through this re-export surface, so a pinned
 * version bump is a contained diff. Everything re-exported here describes
 * PUBLISHED 1.3.0 — upstream main carries unreleased breaking changes
 * (telemetry, onWake, schema v2); do not code against it.
 */

export {
  AssistantEntry,
  // `Harness` is both the `Harness.open` namespace value and the instance type.
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  watchEvents,
} from '@earendil-works/pi-durable'
export type {
  AgentChange,
  AgentEvent,
  AgentEventStream,
  Conversation,
  ConversationCreateOptions,
  ConversationId,
  EntryId,
  Harness as DurableHarness,
  SettledSubmissionRecord,
  SnapshotEvent,
  Submission,
  ToolRegistration,
} from '@earendil-works/pi-durable'
export { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

export { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
export type { Context as ChordContext } from '@earendil-works/chord'

export {
  Type,
  createModels,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai'
export { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
export type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message as PiMessage,
  Model,
  Models,
  ProviderStreams,
  StopReason,
  TextContent,
  Tool as PiTool,
  ToolCall,
  TranscriptContext,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'
