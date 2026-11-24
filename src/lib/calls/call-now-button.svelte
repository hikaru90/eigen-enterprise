<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Zap from '@lucide/svelte/icons/zap'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { ShownError } from '$lib/errors/agent-report'
  import { shownProblemOf, type ScheduleCall, type ScheduleResult } from './client'

  /**
   * "Call now" on /calls: one click starts an instant call of our own and
   * opens it in its tab (the page's `schedule` reserves the tab in the click
   * itself). Nobody is invited yet: inside the call, "Invite people from
   * outside" brings guests (calls.invite_guests) — the same registry action
   * the CLI and the agent use (calls.schedule with invite_later).
   */
  let { schedule }: { schedule: (input: ScheduleCall) => Promise<ScheduleResult> } = $props()

  let busy = $state(false)
  let error = $state<ShownError | null>(null)

  async function onclick() {
    if (busy) return
    error = null
    busy = true
    try {
      await schedule({
        guests: [],
        userIds: [],
        title: null,
        startsAt: null,
        durationMinutes: 60,
        externalUrl: null,
        inviteLater: true,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    } catch (err) {
      error = shownProblemOf(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="flex flex-col items-end gap-2">
  <Button variant="outline" disabled={busy} data-testid="calls-call-now" {onclick}>
    {#if busy}<LoaderCircle class="size-4 animate-spin" aria-hidden="true" />{:else}<Zap
        class="size-4"
        aria-hidden="true"
      />{/if} Call now
  </Button>
  {#if error}<ErrorNotice
      testid="calls-call-now-error"
      error={error.error}
      agent={error.agent}
      attempted="Starting an instant call from /calls"
    />{/if}
</div>
