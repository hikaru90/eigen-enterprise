/**
 * AI co-workers' rhythms on the global job-queue tick (plan/phase-ai-coworkers.md
 * C6): every switched-on rhythm with a due slot queues its run (exactly one
 * across app processes) and starts it in this process. Co-workers are core (no
 * plugin switch). A failure is logged loudly and never stops the rest of the
 * tick; the next pass takes the slot (it stays due until a tick takes it).
 */
export async function tickCoworkerRhythms(): Promise<void> {
  try {
    const [{ liveRhythmDeps }, { tickRhythms }] = await Promise.all([
      import('$lib/server/coworkers/rhythm-live'),
      import('$lib/server/coworkers/rhythms'),
    ])
    const queued = await tickRhythms(await liveRhythmDeps())
    if (queued.length > 0) console.info('[coworkers] rhythm slots queued', { runs: queued.map((r) => r.id) })
  } catch (err) {
    console.error('[coworkers] rhythm tick failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
