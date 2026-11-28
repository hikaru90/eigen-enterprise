/**
 * What's happening (wish 75a4e570) on the global job-queue tick: a fresh digest of observable
 * activity once a day. A failure is logged loudly and never stops the rest of the tick; the
 * dashboard keeps the last digest and its date.
 */
export async function tickPatterns(): Promise<void> {
  try {
    const { tickPatternDigest } = await import('$lib/server/patterns/port')
    await tickPatternDigest()
  } catch (err) {
    console.error('[patterns] background digest failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
