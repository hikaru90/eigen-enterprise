/** Calls for the composition root and routes (implementation in this module). */
export { callsHub, callsService } from './live'
export { callsStreamResponse, CallsHub, type CallFrame } from './hub'
export { callsRoute, guestRoute, readJson, scheduleInputOf, startInputOf } from './http'
export { handleLiveKitWebhook } from './webhook'
export { livekitConfig, type LiveKitConfig } from './livekit'
export { CallsError, CALLS_NOT_SET_UP } from './errors'
export type { CallContext, CallContextPort, CallEnded, CallLogPort, ConversationKind } from './context-port'
export type {
  CallDto,
  CallsService,
  CallTokenDto,
  CallTranscriptDto,
  GuestJoinDto,
  GuestPageView,
  ScheduleResult,
  StartInput,
  TranscriptChunk,
  TranscriptSegmentDto,
} from './service'
export { mergeTranscript, transcriptTurns, MAX_CHUNK_BYTES, TRANSCRIPT_CHUNK_MS, type TranscriptSegment, type TranscriptTurn } from './transcript'
