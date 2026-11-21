<script lang="ts">
  import type { PageProps } from './$types'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import DnsRecordsTable from '$lib/components/email/dns-records-table.svelte'
  import DnsStatus from '$lib/components/email/dns-status.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { shownErrorOf, type ErrorReport } from '$lib/errors/agent-report'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()
  const d = $derived(data.domain)
  let busy = $state<string | null>(null)

  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'not yet'
  const feedback = (action: string) =>
    form && form.action === action
      ? (form as {
          ok?: boolean
          error?: string
          receiving?: boolean
          receivingError?: ErrorReport | null
        })
      : null
  const recheckError = $derived(shownErrorOf(feedback('recheck')))
  const receivingFormError = $derived(shownErrorOf(feedback('receiving')))
  const receivingSetupError = $derived(feedback('receiving')?.receivingError ?? null)
  const deleteError = $derived(shownErrorOf(feedback('delete')))
  const receiving = $derived(data.receiving)
  const mxList = $derived(receiving.currentMx.map((r) => `${r.priority} ${r.exchange}`).join(', '))
  const enhanced = (name: string) => () => {
    busy = name
    return async ({ update }: { update: () => Promise<void> }) => {
      await update()
      busy = null
    }
  }
</script>

<svelte:head><title>{docTitle('Domains', 'Email')}</title></svelte:head>

<div class="mt-8">
  <a
    class="text-[13px] text-muted-foreground hover:text-foreground"
    href={resolve('/m/email/setup')}>← Back to setup</a
  >
  <div class="mt-2 flex flex-wrap items-center gap-3">
    <h2 class="text-base font-semibold tracking-tight" data-testid="domain-name">{d.name}</h2>
    <DnsStatus status={d.status} />
  </div>
  <p class="mt-1 text-sm text-muted-foreground" data-testid="domain-summary">
    {#if d.sendable}
      Verified — you can send from any address at {d.name}.
      {#if d.isVerifying}Amazon is still confirming some records; sending already works.{/if}
    {:else}
      Add these records at your DNS provider (where you bought {d.name}, or Cloudflare, Route 53 …).
      ee re-checks automatically{d.isVerifying ? ' every few minutes' : ''}; DNS changes can take a
      few hours to appear.
    {/if}
  </p>
  {#if d.adopted}
    <p class="mt-1 text-sm text-muted-foreground" data-testid="domain-adopted">
      This domain was already in your Amazon SES account, so ee uses it as it is set up there. If
      these records are already at your DNS provider, there is nothing to add.
    </p>
  {/if}
  {#if data.domainError}<ErrorNotice
      {...data.domainError}
      class="mt-2"
      testid="domain-error"
    />{/if}
</div>

<div class="mt-6">
  <DnsRecordsTable domain={d.name} records={d.records} />
</div>

<p class="mt-2 text-xs text-muted-foreground">Last checked {when(d.lastCheckedAt)}.</p>

{#if data.email.isAdmin}
  <div class="mt-6 flex max-w-3xl flex-col gap-6">
    <form method="POST" action="?/recheck" use:enhance={enhanced('recheck')}>
      <Button
        type="submit"
        variant="outline"
        disabled={busy === 'recheck'}
        data-testid="domain-recheck"
      >
        <RefreshCw class="size-4 {busy === 'recheck' ? 'animate-spin' : ''}" /> Re-check now
      </Button>
      {#if recheckError}<ErrorNotice {...recheckError} class="mt-2" />{/if}
    </form>

    <form
      method="POST"
      action="?/tracking"
      use:enhance={enhanced('tracking')}
      class="rounded-lg border border-border px-4 py-3"
    >
      <label class="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="tracking"
          class="mt-1"
          checked={d.tracking}
          onchange={(e) => e.currentTarget.form?.requestSubmit()}
          data-testid="domain-tracking"
        />
        <span>
          <span class="font-medium">Track opens and clicks</span>
          <span class="block text-muted-foreground"
            >Amazon adds an invisible image and rewrites links so Logs shows when mail is opened and
            clicked. Off by default.</span
          >
        </span>
      </label>
    </form>

    {#if d.sendable || receiving.on}
      <form
        method="POST"
        action="?/receiving"
        use:enhance={({ formElement, cancel }) => {
          const box = formElement.elements.namedItem('receiving') as HTMLInputElement
          if (
            box.checked &&
            !confirm(
              receiving.currentMx.length > 0
                ? `Move all mail for ${d.name} to eigenEnterprise? Today it goes to ${mxList}. Once you change the MX record, that provider gets no more mail for ${d.name}.`
                : `Receive mail for ${d.name} in eigenEnterprise?`,
            )
          ) {
            box.checked = false
            return cancel()
          }
          return enhanced('receiving')()
        }}
        class="rounded-lg border border-border px-4 py-3"
        data-testid="domain-receiving"
      >
        <label class="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="receiving"
            class="mt-1"
            checked={receiving.on}
            disabled={busy === 'receiving'}
            onchange={(e) => e.currentTarget.form?.requestSubmit()}
            data-testid="domain-receiving-switch"
          />
          <span>
            <span class="font-medium">Receive mail on this domain</span>
            <span class="block text-muted-foreground"
              >Mail to the addresses under Setup › Mailboxes arrives in eigenEnterprise. You then
              add the receiving MX record above at your DNS provider.</span
            >
          </span>
        </label>
        {#if !receiving.on}
          {#if receiving.mxError}
            <ErrorNotice {...receiving.mxError} class="mt-2" />
          {:else if receiving.currentMx.length > 0}
            <div
              class="mt-3 rounded-md border border-destructive/40 px-3 py-2 text-sm"
              role="note"
              data-testid="domain-receiving-warning"
            >
              <p class="font-medium">{d.name} already receives mail elsewhere.</p>
              <p class="mt-1 text-muted-foreground">Its MX records point to:</p>
              <ul class="mt-1 font-mono text-xs">
                {#each receiving.currentMx as r (r.exchange)}<li>
                    {r.priority}
                    {r.exchange}
                  </li>{/each}
              </ul>
              <p class="mt-1 text-muted-foreground">
                Switching the MX record moves <strong>all</strong> mail for {d.name} to eigenEnterprise
                — that provider (Google Workspace, Microsoft 365 …) then gets none. Note these records
                down; you need them to switch back.
              </p>
            </div>
          {:else}
            <p class="mt-2 text-xs text-muted-foreground">
              {d.name} has no MX records today, so no mail reaches it yet.
            </p>
          {/if}
        {/if}
        {#if receivingFormError}<ErrorNotice {...receivingFormError} class="mt-2" />{/if}
        {#if receivingSetupError}<ErrorNotice
            error={`Receiving is switched on, but Amazon refused part of the setup: ${receivingSetupError.error}`}
            agent={receivingSetupError.agent}
            class="mt-2"
            testid="domain-receiving-error"
          >
            <a class="underline underline-offset-4" href={resolve('/m/email/setup')}
              >Retry under Setup › Account</a
            >
          </ErrorNotice>{/if}
        {#if feedback('receiving')?.ok && feedback('receiving')?.receiving === false}<p
            class="mt-2 text-sm"
            role="status"
            data-testid="domain-receiving-off"
          >
            Receiving is off: Amazon no longer accepts mail for these addresses. Point the MX record
            of
            {d.name} back to your previous mail provider (and remove the inbound-smtp record), so mail
            reaches it again.
          </p>{/if}
      </form>
    {/if}

    <form
      method="POST"
      action="?/delete"
      use:enhance={({ cancel }) => {
        if (
          !confirm(
            d.adopted
              ? `Remove ${d.name} from ee? Its senders here are removed; the domain stays in your Amazon SES account.`
              : `Remove ${d.name}? Mail can no longer be sent from it, and its senders are removed.`,
          )
        )
          return cancel()
        return enhanced('delete')()
      }}
    >
      <Button type="submit" variant="outline" class="text-destructive" disabled={busy === 'delete'}
        >Remove domain</Button
      >
      {#if deleteError}<ErrorNotice {...deleteError} class="mt-2" />{/if}
    </form>
  </div>
{/if}
