<script lang="ts">
  import type { PageProps } from './$types'
  import { resolve } from '$app/paths'
  import MessageStatus from '$lib/components/email/message-status.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'
  import { SOURCE_LABEL } from '../../../../../../modules/email/platform/status'

  /** Email › Company mail (owner and admins): what the company has waiting to go out and what went out. */
  let { data }: PageProps = $props()

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<svelte:head><title>{docTitle('Company mail', 'Email')}</title></svelte:head>

{#snippet list(
  rows: typeof data.sent,
  empty: string,
  testid: string,
  pending: boolean,
)}
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
                >To {m.to} · {SOURCE_LABEL[m.source] ?? m.source} · {pending && m.scheduledAt
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

{#if !data.connected}
  <div class="rounded-lg border border-border px-4 py-4 text-sm" data-testid="email-not-connected">
    <p>No mail yet: Amazon SES is not connected.</p>
    <Button class="mt-3" size="sm" href="/m/email/setup" data-testid="email-go-setup"
      >Set up email</Button
    >
  </div>
{:else}
  <div class="flex flex-col gap-8">
    <section>
      <SectionHeader
        title="Pending"
        description="Scheduled or queued, not sent yet."
        testid="email-pending-header"
      />
      {@render list(data.pending, 'Nothing waiting to go out.', 'email-pending', true)}
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
      {@render list(data.sent, 'Nothing sent yet.', 'email-sent', false)}
    </section>
  </div>
{/if}
