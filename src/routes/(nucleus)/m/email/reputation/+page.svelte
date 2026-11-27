<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { shownErrorOf } from '$lib/errors/agent-report'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()
  const feedback = (action: string) =>
    form && form.action === action ? (form as { ok?: boolean; error?: string }) : null
  const checkError = $derived(shownErrorOf(feedback('check')))
  const resumeError = $derived(shownErrorOf(feedback('resume')))

  const BAND_LABEL: Record<string, string> = {
    unjudged: 'Not enough mail to judge yet',
    healthy: 'Healthy',
    watch: 'Watch',
    held: 'Sending on hold',
    paused: 'Paused by Amazon',
  }
  const BAND_COPY: Record<string, string> = {
    unjudged:
      'Fewer than 100 recipients in the window: Amazon would not judge this yet either. Mail goes out.',
    healthy: 'Bounces and spam complaints are below Amazon’s lines. Mail goes out.',
    watch: 'Above what Amazon recommends, below its review line. Mail goes out; fix the cause now.',
    held: 'At Amazon’s review line. Nothing but sign-in and system mail goes out until an admin resumes.',
    paused: 'Amazon stopped sending for this account. Nothing goes out until Amazon lifts it.',
  }
  const problem = (band: string) => band === 'held' || band === 'paused'
  const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`)
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<svelte:head><title>{docTitle('Reputation', 'Email')}</title></svelte:head>

<SectionHeader
  title="Reputation"
  description="Your sender reputation against Amazon SES’s criteria. Mail that bounces or is marked as spam is flagged by where it came from; past Amazon’s review line, sending is held before Amazon pauses the account."
/>

{#if !data.configured}
  <p class="mt-4 text-sm text-muted-foreground" data-testid="reputation-not-configured">
    Mail is not set up yet. <a class="underline underline-offset-4" href={resolve('/m/email/setup')}
      >Set it up</a
    > first.
  </p>
{:else}
  {@const r = data.reputation}
  <div class="mt-5 grid gap-x-10 gap-y-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
    <section aria-labelledby="reputation-state">
      <div
        class="rounded-lg border px-4 py-4 sm:px-5 {problem(r.band)
          ? 'border-destructive/50'
          : 'border-border'}"
        data-testid="reputation-state"
        data-band={r.band}
      >
        <div class="flex flex-wrap items-baseline justify-between gap-3">
          <h3
            id="reputation-state"
            class="text-base font-medium {problem(r.band) ? 'text-destructive' : ''}"
          >
            {BAND_LABEL[r.band] ?? r.band}
          </h3>
          {#if data.email.isAdmin}
            <form method="POST" action="?/check" use:enhance>
              <Button type="submit" size="sm" variant="outline" data-testid="reputation-check"
                >Check now</Button
              >
            </form>
          {/if}
        </div>
        <p class="mt-1 text-sm text-muted-foreground">{BAND_COPY[r.band]}</p>
        {#if checkError}<ErrorNotice {...checkError} class="mt-2" />{/if}

        <dl class="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <dt class="text-xs text-muted-foreground">Bounce rate</dt>
            <dd class="mt-0.5 text-xl tabular-nums" data-testid="reputation-bounce-rate">
              {pct(r.rates.bounceRate)}
            </dd>
            <dd class="text-xs text-muted-foreground">
              {r.rates.bounces} of {r.rates.recipients} · review from {pct(
                data.criteria.thresholds.bounce.review,
              )}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Complaint rate</dt>
            <dd class="mt-0.5 text-xl tabular-nums" data-testid="reputation-complaint-rate">
              {pct(r.rates.complaintRate)}
            </dd>
            <dd class="text-xs text-muted-foreground">
              {r.rates.complaints} of {r.rates.recipients} · review from {pct(
                data.criteria.thresholds.complaint.review,
              )}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Amazon says</dt>
            <dd class="mt-0.5 text-sm" data-testid="reputation-amazon">
              {#if !r.amazon}Not read yet{:else if r.amazon.mode === 'own'}{r.amazon.enforcement ===
                'HEALTHY'
                  ? 'Healthy'
                  : r.amazon.enforcement === 'PROBATION'
                    ? 'Under review'
                    : 'Paused'}{r.amazon.sendingEnabled ? '' : ' · sending off'}{:else}{r.amazon
                  .sendingStatus === 'ENABLED'
                  ? 'Sending'
                  : r.amazon.sendingStatus === 'REINSTATED'
                    ? 'Sending again (open findings)'
                    : 'Paused'}{/if}
            </dd>
            {#if r.lastCheck}<dd class="text-xs text-muted-foreground">
                checked {when(r.lastCheck.at)}
              </dd>{/if}
          </div>
        </dl>

        {#if r.reasons.length > 0}
          <ul class="mt-4 list-disc space-y-1 pl-5 text-sm" data-testid="reputation-reasons">
            {#each r.reasons as reason (reason)}<li>{reason}</li>{/each}
          </ul>
        {/if}
        {#if r.lastCheck?.amazonError}
          <p class="mt-3 text-xs text-destructive" data-testid="reputation-amazon-error">
            Amazon could not be read at the last check: {r.lastCheck.amazonError} The last verdict it
            gave still counts.
          </p>
        {/if}
        {#if !r.tracking}
          <p class="mt-3 text-xs text-muted-foreground" data-testid="reputation-no-tracking">
            Delivery tracking is off, so bounces and complaints never reach this page; only Amazon’s
            verdict counts. Set it up under <a
              class="underline underline-offset-4"
              href={resolve('/m/email/setup')}>Account</a
            >.
          </p>
        {/if}
      </div>

      {#if data.email.isAdmin && (r.sendingHeld || r.slices.some((s) => s.band === 'held')) && r.band !== 'paused'}
        <form
          method="POST"
          action="?/resume"
          class="mt-4 grid max-w-2xl gap-2"
          use:enhance
          data-testid="reputation-resume"
        >
          <Label for="resume-reason">Resume sending</Label>
          <p class="text-xs text-muted-foreground">
            First remove what caused it: the bought or old list, the address that keeps bouncing,
            the flow that mails people who never opted in. The rates then count from now, and the
            next mail is judged fresh.
          </p>
          <Textarea
            id="resume-reason"
            name="reason"
            required
            maxlength={500}
            rows={2}
            placeholder="What was fixed"
          />
          <div><Button type="submit" variant="outline">Resume sending</Button></div>
          {#if resumeError}<ErrorNotice {...resumeError} />{/if}
        </form>
      {/if}

      <section class="mt-8" aria-labelledby="reputation-flagged">
        <h3 id="reputation-flagged" class="text-sm font-medium">Flagged</h3>
        {#if r.slices.length === 0}
          <p class="mt-2 text-sm text-muted-foreground" data-testid="reputation-flagged-empty">
            Nothing stands out: no kind of mail, sender, flow or API key is above Amazon’s lines.
          </p>
        {:else}
          <ul
            class="mt-2 divide-y divide-border rounded-lg border border-border"
            data-testid="reputation-flagged"
          >
            {#each r.slices as s (`${s.dimension}:${s.value}`)}
              <li
                class="px-4 py-3 sm:px-5"
                data-testid={`flagged-${s.dimension}`}
                data-band={s.band}
              >
                <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span class="min-w-0 flex-1 truncate text-sm font-medium">
                    {#if s.flowId}<a
                        class="underline underline-offset-4"
                        href={resolve('/m/email/marketing/flows/[id]', { id: s.flowId })}
                        >{s.label}</a
                      >{:else if s.apiKey}<a
                        class="underline underline-offset-4"
                        href={resolve('/m/email/api')}>{s.label}</a
                      >{:else}{s.label}{/if}
                  </span>
                  <span
                    class="text-xs {s.band === 'held'
                      ? 'text-destructive'
                      : 'text-muted-foreground'}">{s.band === 'held' ? 'On hold' : 'Watch'}</span
                  >
                  <span class="text-xs text-muted-foreground tabular-nums"
                    >{pct(s.bounceRate)} bounced · {pct(s.complaintRate)} spam · {s.recipients} recipients</span
                  >
                </div>
                {#each s.reasons as reason (reason)}<p class="mt-1 text-xs text-muted-foreground">
                    {reason}
                  </p>{/each}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="mt-8" aria-labelledby="reputation-history">
        <h3 id="reputation-history" class="text-sm font-medium">History</h3>
        {#if data.history.length === 0}
          <p class="mt-2 text-sm text-muted-foreground">
            No check recorded yet. The first runs within the hour.
          </p>
        {:else}
          <div class="mt-2 overflow-x-auto rounded-lg border border-border">
            <table class="w-full text-sm" data-testid="reputation-history">
              <thead class="text-left text-xs text-muted-foreground">
                <tr>
                  <th class="px-4 py-2 font-normal">Checked</th>
                  <th class="px-4 py-2 font-normal">State</th>
                  <th class="px-4 py-2 text-right font-normal">Bounces</th>
                  <th class="px-4 py-2 text-right font-normal">Spam</th>
                  <th class="px-4 py-2 text-right font-normal">Recipients</th>
                  <th class="px-4 py-2 font-normal">Amazon</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                {#each data.history as c (c.id)}
                  <tr>
                    <td class="px-4 py-2 whitespace-nowrap">{when(c.at)}</td>
                    <td class="px-4 py-2 {problem(c.band) ? 'text-destructive' : ''}"
                      >{BAND_LABEL[c.band] ?? c.band}</td
                    >
                    <td class="px-4 py-2 text-right tabular-nums">{pct(c.bounceRate)}</td>
                    <td class="px-4 py-2 text-right tabular-nums">{pct(c.complaintRate)}</td>
                    <td class="px-4 py-2 text-right tabular-nums">{c.recipients}</td>
                    <td class="px-4 py-2 text-xs text-muted-foreground"
                      >{c.amazonError ? 'not readable' : (c.amazon ?? '—')}</td
                    >
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    </section>

    <aside class="flex flex-col gap-6 text-sm" aria-label="Criteria">
      <div class="rounded-lg border border-border px-4 py-3">
        <h3 class="font-medium">Amazon’s criteria</h3>
        <ul class="mt-2 space-y-1.5 text-muted-foreground">
          <li>
            Bounces: below {pct(data.criteria.thresholds.bounce.watch)} healthy, review from {pct(
              data.criteria.thresholds.bounce.review,
            )}, pause from {pct(data.criteria.thresholds.bounce.pause)}.
          </li>
          <li>
            Spam complaints: review from {pct(data.criteria.thresholds.complaint.review)}, pause
            from {pct(data.criteria.thresholds.complaint.pause)}.
          </li>
          <li>
            Counted over the last {data.criteria.window.mails.toLocaleString()} mails of {data
              .criteria.window.days} days{r.since ? `, since ${when(r.since)}` : ''}; bounces judged
            from {data.criteria.volume.bounce} recipients, complaints from {data.criteria.volume.complaint.toLocaleString()}.
          </li>
          <li>Only permanent bounces count; addresses that bounce or complain are suppressed.</li>
          <li>Sign-in codes and other system mail are never held.</li>
        </ul>
      </div>
      {#if data.resumes.length > 0}
        <div class="rounded-lg border border-border px-4 py-3" data-testid="reputation-resumes">
          <h3 class="font-medium">Resumes</h3>
          <ul class="mt-2 space-y-2">
            {#each data.resumes as x (x.id)}
              <li>
                <span class="text-xs text-muted-foreground"
                  >{when(x.at)} · was {BAND_LABEL[x.band] ?? x.band}, {pct(x.bounceRate)} bounced</span
                >
                <p>{x.reason}</p>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </aside>
  </div>
{/if}
