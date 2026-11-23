<script lang="ts">
  import MessageSquare from '@lucide/svelte/icons/message-square'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { shownErrorOf, type ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * "Message": opens (or finds) the DM with this person or co-worker through
   * the existing route (POST /api/messages/dms = messages.open_dm) and goes to
   * it in Messages.
   */
  let { userId, name }: { userId: string; name: string } = $props()

  let busy = $state(false)
  let failed = $state<ShownError | null>(null)

  async function open() {
    busy = true
    failed = null
    try {
      const res = await fetch('/api/messages/dms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userIds: [userId] }),
      })
      const body = (await res.json().catch(() => ({}))) as { conversation?: { id: string } }
      if (!res.ok || !body.conversation) {
        failed = shownErrorOf(body) ?? { error: m.coworkers_message_failed(), agent: null }
        return
      }
      await goto(resolve(`/messages?c=${encodeURIComponent(body.conversation.id)}`))
    } catch (err) {
      failed = { error: err instanceof Error ? err.message : String(err), agent: null }
    } finally {
      busy = false
    }
  }
</script>

<div class="flex flex-col items-start gap-2">
  <Button type="button" size="sm" disabled={busy} onclick={open} data-testid="profile-message">
    <MessageSquare aria-hidden="true" />{m.coworkers_message()}<span class="sr-only">: {name}</span>
  </Button>
  {#if failed}
    <ErrorNotice error={failed.error} agent={failed.agent} attempted={m.coworkers_message_attempted({ name })} />
  {/if}
</div>
