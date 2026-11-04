<script lang="ts">
  import { docTitle } from '$lib/shell/title'
  import type { PageProps } from './$types'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import CopyButton from '$lib/components/email/copy-button.svelte'
  import DnsStatus from '$lib/components/email/dns-status.svelte'
  import { Button } from '$lib/components/ui/button'

  let { data, form }: PageProps = $props()
  const d = $derived(data.domain)
  let busy = $state<string | null>(null)

  const PURPOSE: Record<string, string> = {
    dkim: 'DKIM — signs every mail so inboxes know it really comes from you.',
    mail_from_mx: 'Mail-from (MX) — bounces come back to Amazon through mail.<domain>.',
    spf: 'SPF — allows Amazon SES to send for your mail-from address.',
    dmarc: 'DMARC (recommended) — tells inboxes what to do with mail that fails the checks.',
  }
  const purpose = (p: string) => PURPOSE[p]!.replace('<domain>', d.name)
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'not yet'
  const feedback = (action: string) =>
    form && form.action === action ? (form as { ok?: boolean; error?: string }) : null
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
    href={resolve('/m/email/domains')}>← Back to domains</a
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
  {#if d.errorMessage}<p
      class="mt-2 text-sm text-destructive"
      role="alert"
      data-testid="domain-error"
    >
      {d.errorMessage}
    </p>{/if}
</div>

<div class="mt-6 overflow-x-auto rounded-lg border border-border">
  <table class="w-full min-w-[44rem] text-left text-sm" data-testid="dns-records">
    <thead class="border-b border-border text-xs text-muted-foreground">
      <tr>
        <th class="px-4 py-2.5 font-medium">Type</th>
        <th class="px-4 py-2.5 font-medium">Host / name</th>
        <th class="px-4 py-2.5 font-medium">Value</th>
        <th class="px-4 py-2.5 font-medium">Priority</th>
        <th class="px-4 py-2.5 font-medium">Status</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-border align-top">
      {#each d.records as r (r.purpose)}
        <tr data-testid={`dns-record-${r.purpose}`}>
          <td class="px-4 py-3 font-mono text-xs">{r.type}</td>
          <td class="px-4 py-3">
            <div class="flex items-start gap-1">
              <code class="font-mono text-xs break-all">{r.host}</code>
              <CopyButton value={r.host} label={`Copy host of the ${r.purpose} record`} />
            </div>
            <p class="mt-1 text-[11px] text-muted-foreground">{r.name}</p>
          </td>
          <td class="px-4 py-3">
            <div class="flex items-start gap-1">
              <code class="max-w-[28rem] font-mono text-xs break-all" data-testid="dns-value"
                >{r.value}</code
              >
              <CopyButton value={r.value} label={`Copy value of the ${r.purpose} record`} />
            </div>
            <p class="mt-1 text-[11px] text-muted-foreground">{purpose(r.purpose)}</p>
          </td>
          <td class="px-4 py-3 text-xs tabular-nums">{r.priority ?? '—'}</td>
          <td class="px-4 py-3"><DnsStatus status={r.status} /></td>
        </tr>
      {/each}
    </tbody>
  </table>
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
      {#if feedback('recheck')?.error}<p class="mt-2 text-sm text-destructive" role="alert">
          {feedback('recheck')?.error}
        </p>{/if}
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

    <form
      method="POST"
      action="?/delete"
      use:enhance={({ cancel }) => {
        if (
          !confirm(
            `Remove ${d.name}? Mail can no longer be sent from it, and its senders are removed.`,
          )
        )
          return cancel()
        return enhanced('delete')()
      }}
    >
      <Button type="submit" variant="outline" class="text-destructive" disabled={busy === 'delete'}
        >Remove domain</Button
      >
      {#if feedback('delete')?.error}<p class="mt-2 text-sm text-destructive" role="alert">
          {feedback('delete')?.error}
        </p>{/if}
    </form>
  </div>
{/if}
