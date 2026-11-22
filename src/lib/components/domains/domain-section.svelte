<script lang="ts">
  import type { DomainView } from '../../../../modules/domains/view'
  import { enhance } from '$app/forms'
  import CopyButton from '$lib/components/email/copy-button.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import StatusPill from '$lib/components/page/status-pill.svelte'
  import { Button } from '$lib/components/ui/button'
  import { STATE_LABEL } from '$lib/domains/contract'
  import {
    dnsSummary,
    encodeShows,
    hostReadiness,
    recordsToFix,
    showsLabel,
    targetChoices,
    type HostView,
    type ObservedRecord,
    type ShowsTarget,
  } from '$lib/domains/host-status'

  /**
   * One domain on Settings › Domains (plan/domains-one-claim.md): its
   * hostnames — what each shows (a picker, with a confirmation naming what it
   * shows now), email, DNS, claim, certificate — then "Records to add" (only
   * what is missing or wrong) and "Add a hostname". Every button is a form
   * action that runs a domains registry tool; the page shows its answer.
   */
  let {
    domain,
    managed,
    apps,
    mailNote = null,
  }: {
    domain: DomainView
    /** Under ee: what a host shows can be changed. */
    managed: boolean
    /** The apps a host can show. */
    apps: string[]
    mailNote?: string | null
  } = $props()

  /** A picked target waiting for its confirmation. */
  let pending = $state<{ host: string; to: ShowsTarget } | null>(null)
  let removing = $state<string | null>(null)

  const choices = $derived(targetChoices(apps))
  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
  const anyClaim = $derived(domain.hosts.some((h) => h.claim !== null))

  /** Records to add across the domain's hosts, each once. */
  const toAdd = $derived.by(() => {
    const seen: string[] = []
    const out: ObservedRecord[] = []
    for (const h of domain.hosts) {
      for (const r of recordsToFix(h.records)) {
        const key = `${r.type} ${r.name} ${r.value}`
        if (seen.includes(key)) continue
        seen.push(key)
        out.push(r)
      }
    }
    return out
  })

  const PURPOSE: Record<string, string> = {
    web: 'Web — points this address at the company’s server.',
    calls: 'Calls — points the calls address at the company’s server.',
    claim: 'Claim — proves the company owns this address before it is served.',
    mail_dkim: 'Email (DKIM) — signs mail so inboxes know it really comes from you.',
    mail_mail_from_mx: 'Email (mail-from MX) — bounces come back through this subdomain.',
    mail_spf: 'Email (SPF) — allows Amazon SES to send for the mail-from address.',
    mail_dmarc:
      'Email (DMARC) — tells inboxes what to do with mail that fails the checks. A stricter policy you already have (quarantine or reject) is fine.',
    mail_inbound_mx: 'Email (receiving MX) — sends mail for this domain to Amazon SES.',
  }

  function pick(h: HostView, value: string): void {
    const to = choices.find((c) => encodeShows(c) === value)
    pending = to ? { host: h.host, to } : null
  }

  const email = (h: HostView) =>
    !h.email
      ? '—'
      : [h.email.sending ? 'Sending' : null, h.email.receiving ? 'Receiving' : null]
          .filter(Boolean)
          .join(' · ') || 'Not verified yet'

  /** The host's readiness as the one status pill (on = live). */
  function hostReadinessPill(h: HostView): { label: string; on: boolean } {
    const r = hostReadiness(h)
    return { label: r.label, on: r.tone === 'ok' }
  }

  const removable = (h: HostView) =>
    managed && h.shows.kind !== 'console' && h.shows.kind !== 'calls' && h.shows.kind !== 'nothing'
  const certWaiting = (h: HostView) =>
    managed && (h.certificate?.state === 'failing' || h.certificate?.state === 'pending')

  /** Close the confirmation once the action answered (the page shows the answer). */
  const closing = () => {
    return async ({ update }: { update: () => Promise<void> }) => {
      await update()
      pending = null
      removing = null
    }
  }
</script>

<section
  id={domain.name}
  class="mt-8 rounded-lg border border-border"
  data-testid="domain-section"
  aria-label={domain.name}
>
  <header class="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
    <div class="min-w-0">
      <h3 class="truncate text-sm font-semibold">{domain.name}</h3>
      <p class="mt-0.5 text-xs text-muted-foreground" data-testid="domain-source">
        {#if domain.bought}
          Bought through eigenEnterprise
          {#if domain.bought.renewsAt}
            · {domain.bought.autoRenew
              ? `Renews ${date(domain.bought.renewsAt)}`
              : `Runs out ${date(domain.bought.renewsAt)} (renewal off)`}
          {/if}
          · <span data-testid="domain-state">{STATE_LABEL[domain.bought.state]}</span>
        {:else}
          In your own DNS
        {/if}
      </p>
      {#if domain.bought?.error}
        <ErrorNotice
          class="mt-1 text-xs"
          error={domain.bought.error}
          attempted={`Registering the bought domain ${domain.name} (the control plane reported it failed)`}
        />
      {/if}
      {#if mailNote}<p class="mt-1 text-xs text-muted-foreground">{mailNote}</p>{/if}
    </div>
    {#if domain.hosts.length > 0}
      <form method="POST" action="?/recheck" use:enhance>
        <input type="hidden" name="domain" value={domain.name} />
        {#each domain.hosts as h (h.host)}<input type="hidden" name="host" value={h.host} />{/each}
        <Button type="submit" size="sm" variant="outline">Check now</Button>
      </form>
    {/if}
  </header>

  {#if domain.hosts.length === 0}
    <p class="px-4 py-4 text-sm text-muted-foreground">No hostnames use this domain yet.</p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full min-w-[48rem] text-left text-sm">
        <thead class="border-b border-border text-xs text-muted-foreground">
          <tr>
            <th class="px-4 py-2.5 font-medium">Address</th>
            <th class="px-4 py-2.5 font-medium">Shows</th>
            <th class="px-4 py-2.5 font-medium">Email</th>
            <th class="px-4 py-2.5 font-medium">DNS</th>
            {#if anyClaim}<th class="px-4 py-2.5 font-medium">Claim</th>{/if}
            <th class="px-4 py-2.5 font-medium">Certificate</th>
            <th class="px-4 py-2.5"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border align-top">
          {#each domain.hosts as h (h.host)}
            {@const dns = dnsSummary(h.records)}
            <tr id={h.host} data-testid="host-row" class="target:bg-muted/40">
              <td class="px-4 py-3">
                <p class="font-medium break-all">{h.host}</p>
                <div class="mt-1"><StatusPill {...hostReadinessPill(h)} /></div>
              </td>
              <td class="px-4 py-3">
                {#if h.shows.kind === 'calls'}
                  <span data-testid="host-shows">Calls</span>
                {:else if !managed}
                  <span class="text-muted-foreground" data-testid="host-shows">—</span>
                {:else}
                  <select
                    class="h-9 border border-input bg-card px-2 text-xs"
                    aria-label={`What ${h.host} shows`}
                    value={pending?.host === h.host
                      ? encodeShows(pending.to)
                      : encodeShows(h.shows as ShowsTarget)}
                    onchange={(e) => pick(h, e.currentTarget.value)}
                  >
                    {#each choices as c (encodeShows(c))}
                      <option value={encodeShows(c)}>{showsLabel(c)}</option>
                    {/each}
                    {#if h.shows.kind === 'app' && !apps.includes(h.shows.app)}
                      <option value={encodeShows(h.shows)}>{showsLabel(h.shows)}</option>
                    {/if}
                  </select>
                {/if}
              </td>
              <td class="px-4 py-3 text-xs" data-testid="host-email">{email(h)}</td>
              <td class="px-4 py-3" data-testid="host-dns">
                <StatusPill label={dns.label} on={dns.tone === 'ok'} />
              </td>
              {#if anyClaim}
                <td class="px-4 py-3 text-xs" data-testid="host-claim">
                  {#if h.claim === null}—{:else if h.claim.verified}Verified{:else}Waiting for the
                    TXT record{/if}
                </td>
              {/if}
              <td class="px-4 py-3 text-xs" data-testid="host-certificate">
                {#if h.certificate === null}
                  <span class="text-muted-foreground">—</span>
                {:else if h.certificate.state === 'issued'}
                  Issued{h.certificate.notAfter ? ` until ${date(h.certificate.notAfter)}` : ''}
                {:else if h.certificate.state === 'pending'}
                  Pending
                {:else}
                  <p class="text-destructive">Failing</p>
                  {#if h.certificate.lastError}
                    <p class="mt-1 break-all text-muted-foreground">{h.certificate.lastError}</p>
                  {/if}
                  {#if h.certificate.nextRetryAt}
                    <p class="mt-1 text-muted-foreground">
                      Next try {new Date(h.certificate.nextRetryAt).toLocaleString()}
                    </p>
                  {/if}
                {/if}
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap justify-end gap-2">
                  {#if certWaiting(h)}
                    <form method="POST" action="?/retryCertificate" use:enhance>
                      <input type="hidden" name="host" value={h.host} />
                      <Button type="submit" size="sm" variant="outline">Retry certificate</Button>
                    </form>
                  {/if}
                  {#if removable(h)}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onclick={() => (removing = h.host)}>Remove</Button
                    >
                  {/if}
                </div>
              </td>
            </tr>
            {#if pending?.host === h.host}
              {@const to = pending.to}
              <tr data-testid="shows-confirm">
                <td colspan="7" class="bg-muted/30 px-4 py-3">
                  <form
                    method="POST"
                    action="?/setTarget"
                    use:enhance={closing}
                    class="flex flex-wrap items-center gap-3"
                  >
                    <input type="hidden" name="host" value={h.host} />
                    <input type="hidden" name="shows" value={encodeShows(to)} />
                    <p class="text-sm">
                      {h.host} shows {showsLabel(h.shows).toLowerCase()} now. Show {showsLabel(
                        to,
                      ).toLowerCase()} instead?
                    </p>
                    <Button type="submit" size="sm">Change</Button>
                    <Button type="button" size="sm" variant="ghost" onclick={() => (pending = null)}
                      >Cancel</Button
                    >
                  </form>
                </td>
              </tr>
            {/if}
            {#if removing === h.host}
              <tr data-testid="remove-confirm">
                <td colspan="7" class="bg-muted/30 px-4 py-3">
                  <form
                    method="POST"
                    action="?/remove"
                    use:enhance={closing}
                    class="flex flex-wrap items-center gap-3"
                  >
                    <input type="hidden" name="host" value={h.host} />
                    <p class="text-sm">
                      Take {h.host} off this server? It shows {showsLabel(h.shows).toLowerCase()} now.
                    </p>
                    <Button type="submit" size="sm" variant="destructive">Remove</Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onclick={() => (removing = null)}>Keep it</Button
                    >
                  </form>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if toAdd.length > 0}
    <div class="border-t border-border px-4 py-3" data-testid="records-to-add">
      <h4 class="text-xs font-semibold">Records to add</h4>
      <p class="mt-0.5 text-xs text-muted-foreground">
        Add or change these where {domain.name}’s DNS is managed. DNS changes can take a while to
        appear; “Check now” looks again.
      </p>
      <ul class="mt-3 space-y-3">
        {#each toAdd as r (`${r.type} ${r.name} ${r.value}`)}
          <li class="text-xs" data-testid="record-to-add">
            <div class="flex flex-wrap items-start gap-x-4 gap-y-1">
              <span class="w-12 font-mono">{r.type}</span>
              <span class="flex min-w-0 items-start gap-1">
                <code class="font-mono break-all">{r.name}</code>
                <CopyButton value={r.name} label={`Copy the name of the ${r.type} record`} />
              </span>
              <span class="flex min-w-0 items-start gap-1">
                <code class="font-mono break-all" data-testid="record-value"
                  >{r.priority !== undefined ? `${r.priority} ` : ''}{r.value}</code
                >
                <CopyButton value={r.value} label={`Copy the value of the ${r.type} record`} />
              </span>
            </div>
            <p class="mt-1 text-muted-foreground">
              {PURPOSE[r.purpose] ?? r.purpose}
              {#if r.status === 'wrong'}
                <span data-testid="record-observed">DNS shows now: {r.observed.join(', ')}.</span>
              {/if}
            </p>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if managed}
    <form
      method="POST"
      action="?/addHost"
      use:enhance
      class="flex flex-wrap items-end gap-2 border-t border-border px-4 py-3"
      data-testid="add-host"
    >
      <input type="hidden" name="domain" value={domain.name} />
      <label class="text-xs text-muted-foreground">
        Add a hostname
        <span class="mt-1 flex items-center gap-1">
          <input
            name="label"
            class="h-9 w-32 border border-input bg-card px-2 text-sm text-foreground"
            placeholder="www"
            autocomplete="off"
            spellcheck="false"
            aria-label={`New hostname under ${domain.name}`}
          />
          <span class="text-sm text-foreground">.{domain.name}</span>
        </span>
      </label>
      <label class="text-xs text-muted-foreground">
        Shows
        <select
          name="shows"
          class="mt-1 block h-9 border border-input bg-card px-2 text-xs text-foreground"
          aria-label={`What the new hostname under ${domain.name} shows`}
        >
          {#each choices.filter((c) => c.kind !== 'nothing') as c (encodeShows(c))}
            <option value={encodeShows(c)}>{showsLabel(c)}</option>
          {/each}
        </select>
      </label>
      <Button type="submit" size="sm" variant="outline">Add</Button>
    </form>
  {/if}
</section>
