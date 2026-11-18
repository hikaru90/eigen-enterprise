<script lang="ts">
  import type { DnsRecord } from '../../../../modules/email/platform/dns'
  import CopyButton from '$lib/components/email/copy-button.svelte'
  import DnsStatus from '$lib/components/email/dns-status.svelte'

  /**
   * A mail domain's DNS records with copy buttons and per-record status — the
   * one records view (Email › Domains › <domain>, the onboarding's Domain act,
   * Settings › Domains).
   */
  let { domain, records }: { domain: string; records: DnsRecord[] } = $props()

  const PURPOSE: Record<string, string> = {
    dkim: 'DKIM — signs every mail so inboxes know it really comes from you.',
    mail_from_mx: 'Mail-from (MX) — bounces come back to Amazon through this subdomain.',
    spf: 'SPF — allows Amazon SES to send for your mail-from address.',
    dmarc: 'DMARC (recommended) — tells inboxes what to do with mail that fails the checks.',
    inbound_mx:
      'Receiving (MX) — sends all mail for <domain> to Amazon SES, which hands it to eigenEnterprise.',
  }
  const purpose = (p: string) => PURPOSE[p]!.replace('<domain>', domain)
</script>

<div class="overflow-x-auto rounded-lg border border-border">
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
      {#each records as r (`${r.purpose}:${r.name}`)}
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
            {#if r.value === null}
              <p class="text-xs text-muted-foreground" data-testid="dns-value">
                The public key you published with this DKIM key (Amazon doesn’t show it).
              </p>
            {:else}
              <div class="flex items-start gap-1">
                <code class="max-w-[28rem] font-mono text-xs break-all" data-testid="dns-value"
                  >{r.value}</code
                >
                <CopyButton value={r.value} label={`Copy value of the ${r.purpose} record`} />
              </div>
            {/if}
            <p class="mt-1 text-[11px] text-muted-foreground">{purpose(r.purpose)}</p>
          </td>
          <td class="px-4 py-3 text-xs tabular-nums">{r.priority ?? '—'}</td>
          <td class="px-4 py-3"><DnsStatus status={r.status} /></td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
