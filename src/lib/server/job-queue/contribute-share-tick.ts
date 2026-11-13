/**
 * Contribute's sharing with the central board on the global job-queue tick
 * (plan/contribute-phone-home.md §5): scrubs and sends due outbox rows. A
 * failure is logged loudly and never stops the rest of the tick; the reason
 * is also stored and shown in Settings → Company.
 */
export async function tickContributeShare(): Promise<void> {
  try {
    const { shareTick } = await import('../../../../modules/contribute/share/live')
    await shareTick()
  } catch (err) {
    console.error('[contribute.share] background tick failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
