/**
 * The email module's background work on the global job-queue tick (no second
 * process): domain DNS re-checks and the due rows of `mail_jobs` (scheduled
 * sends, flow steps). A failure is logged loudly and never stops the rest of
 * the tick; the work is retried on the next pass.
 */
export async function tickEmailPlatform(): Promise<void> {
  try {
    const { emailPlatform } = await import('../../../../modules/email/platform/service')
    const out = await emailPlatform().tick()
    if (out.domains > 0 || out.jobs.done > 0 || out.jobs.failed > 0) console.info('[email] background tick', out)
  } catch (err) {
    console.error('[email] background tick failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
