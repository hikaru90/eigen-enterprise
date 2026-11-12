/**
 * The GitHub repos plugin's sync on the global job-queue tick
 * (plan/github-drive.md §3): claims due repos (SKIP LOCKED) and syncs them.
 * The kernel is bootstrapped first because it wires the plugin's ports. A
 * failure is logged loudly and never stops the rest of the tick.
 */
export async function tickRepos(): Promise<void> {
  try {
    const { bootstrapKernel } = await import('../../../../modules/index')
    bootstrapKernel()
    const { reposTick } = await import('../../../../modules/repos/live')
    await reposTick()
  } catch (err) {
    console.error('[repos] background tick failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
