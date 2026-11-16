<script lang="ts">
  import { resolve } from '$app/paths'
  import MessageStatus from '$lib/components/email/message-status.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { SOURCE_LABEL } from '../../../../modules/email/platform/status'

  type Row = {
    id: string
    to: string
    subject: string
    status: string
    source: string
    scheduledAt: string | null
    createdAt: string
  }

  /**
   * One kind of company mail (transactional or marketing): what waits to go out, and what went out. Was the
   * Company mail page's body until 2026-11-16; both Transactional mail and Marketing mail › Sent show it now.
   */
  let {
    connected,
    pending,
    sent,
    pendingEmpty,
    sentEmpty,
  }: { connected: boolean; pending: Row[]; sent: Row[]; pendingEmpty: string; sentEmpty: string } = $props()

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

{#snippet list(rows: Row[], empty: string, testid: string, isPending: boolean)}
  {#if rows.length === 0}
    <p class="mt-3 text-sm text-muted-foreground" data-testid={`${testid}-empty`}>{empty}</p>
  {:else}
    <ul class="mt-3 divide-y divide-border rounded-lg border border-border" data-testid={testid}>
      {#each rows as m (m.id)}
        <li>
          <a
            class="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
            href={resolve(`/m/email/logs/${m.id}`)}
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{m.subject}</span>
              <span class="block truncate text-xs text-muted-foreground"
                >To {m.to} · {SOURCE_LABEL[m.source] ?? m.source} · {isPending && m.scheduledAt
                  ? `for ${when(m.scheduledAt)}`
                  : when(m.createdAt)}</span
              >
            </span>
            <MessageStatus status={m.status} />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#if !connected}
  <div class="rounded-lg border border-border px-4 py-4 text-sm" data-testid="email-not-connected">
    <p>No mail yet: Amazon SES is not connected.</p>
    <Button class="mt-3" size="sm" href="/m/email/setup" data-testid="email-go-setup">Set up email</Button>
  </div>
{:else}
  <div class="flex flex-col gap-8">
    <section>
      <SectionHeader
        title="Pending"
        description="Scheduled or queued, not sent yet."
        testid="email-pending-header"
      />
      {@render list(pending, pendingEmpty, 'email-pending', true)}
    </section>
    <section>
      <SectionHeader title="Sent" testid="email-sent-header">
        {#snippet actions()}
          <a
            class="text-[13px] text-muted-foreground underline-offset-4 hover:underline"
            href={resolve('/m/email/logs')}>All mail</a
          >
        {/snippet}
      </SectionHeader>
      {@render list(sent, sentEmpty, 'email-sent', false)}
    </section>
  </div>
{/if}
