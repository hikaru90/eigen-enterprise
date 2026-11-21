<script lang="ts">
  import type { CallDto, CallsClient, ScheduleResult } from './client'
  import Copy from '@lucide/svelte/icons/copy'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import type { ShownError } from '$lib/errors/agent-report'
  import { shownProblemOf } from './client'

  /**
   * The host's view of a meeting's guests (proposal 844bab56): who was
   * invited, who came, withdraw a link (a guest in the call is removed from
   * it), invite more by email — each new link shown once to copy.
   */
  let {
    call,
    client,
    onchange,
  }: {
    call: CallDto
    client: Pick<CallsClient, 'inviteGuests' | 'revokeGuest'>
    onchange: (call: CallDto) => void
  } = $props()

  let more = $state('')
  let busy = $state(false)
  let error = $state<ShownError | null>(null)
  let invited = $state<ScheduleResult | null>(null)

  const statusOf = (g: CallDto['guests'][number]) =>
    g.revoked
      ? 'Link withdrawn'
      : g.inRoom
        ? 'In the call'
        : g.joined
          ? 'Joined earlier'
          : 'Invited'

  async function withdraw(guestId: string) {
    error = null
    busy = true
    try {
      onchange(await client.revokeGuest(call.id, guestId))
    } catch (err) {
      error = shownProblemOf(err)
    } finally {
      busy = false
    }
  }

  async function invite(e: SubmitEvent) {
    e.preventDefault()
    const emails = more
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (emails.length === 0 || busy) return
    error = null
    busy = true
    try {
      invited = await client.inviteGuests(
        call.id,
        emails,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      )
      more = ''
      onchange(invited.call)
    } catch (err) {
      error = shownProblemOf(err)
    } finally {
      busy = false
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
    } catch (err) {
      error = {
        error: `Could not copy the link (${err instanceof Error ? err.message : String(err)}).`,
        agent: null,
      }
    }
  }
</script>

<div class="flex flex-col gap-4" data-testid="meeting-guests">
  {#if call.guests.length === 0}
    <p class="text-sm text-muted-foreground">No guests yet.</p>
  {:else}
    <ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
      {#each call.guests as g (g.id)}
        <li
          class="flex items-center gap-3 px-3 py-2"
          data-testid="meeting-guest"
          data-id={g.id}
          data-revoked={g.revoked ? 'true' : 'false'}
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{g.name ?? g.email}</p>
            <p class="truncate text-xs text-muted-foreground">
              {g.name ? `${g.email} · ` : ''}{statusOf(g)}
            </p>
          </div>
          {#if !g.revoked}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onclick={() => withdraw(g.id)}
              aria-label={`Withdraw the link of ${g.email}`}>Withdraw</Button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if call.state !== 'ended' && call.state !== 'missed' && call.state !== 'declined'}
    <form class="flex flex-col gap-1.5" onsubmit={invite}>
      <Label for="meeting-guests-more">Invite more (email)</Label>
      <div class="flex gap-2">
        <Input
          dictation={false}
          id="meeting-guests-more"
          bind:value={more}
          placeholder="name@partner.com"
        />
        <Button type="submit" disabled={busy || more.trim() === ''}>Invite</Button>
      </div>
    </form>
  {/if}

  {#if invited && invited.invitations.length > 0}
    {#if !invited.mailConfigured}
      <p
        class="rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-sm"
        role="status"
      >
        Email isn’t set up — copy the link instead.
      </p>
    {/if}
    <ul class="flex flex-col gap-1">
      {#each invited.invitations as inv (inv.guestId)}
        <li class="flex items-center gap-2 text-sm">
          <span class="min-w-0 flex-1 truncate"
            >{inv.email} · {inv.emailed
              ? 'Emailed'
              : inv.error
                ? `Not sent: ${inv.error}`
                : 'Not emailed'}</span
          >
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Copy link for ${inv.email}`}
            onclick={() => copy(inv.url)}
            ><Copy class="size-4" aria-hidden="true" /> Copy link</Button
          >
        </li>
      {/each}
    </ul>
  {/if}

  {#if error}<ErrorNotice
      error={error.error}
      agent={error.agent}
      attempted="Managing the guests of a call"
    />{/if}
</div>
