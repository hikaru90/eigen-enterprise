<script lang="ts">
  import { docTitle } from '$lib/shell/title'
  import type { PageProps } from './$types'
  import Check from '@lucide/svelte/icons/check'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import MessageStatus from '$lib/components/email/message-status.svelte'
  import SesConnectForm from '$lib/components/email/ses-connect-form.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'

  let { data, form }: PageProps = $props()
  const isAdmin = $derived(data.email.isAdmin)
  const account = $derived(data.account)
  const firstDomain = $derived(data.domains[0] ?? null)
  const verifiedDomain = $derived(data.domains.find((d) => d.sendable) ?? null)
  const feedback = (action: string) =>
    form && form.action === action
      ? (form as { ok?: boolean; error?: string; sentTo?: string })
      : null
  let busy = $state<string | null>(null)
  let changingKeys = $state(false)

  type Step = { id: string; title: string; done: boolean; detail: string }
  const steps = $derived<Step[]>([
    {
      id: 'connect',
      title: 'Connect Amazon SES',
      done: Boolean(account),
      detail: account
        ? `Connected in ${account.region}. Default sender: ${account.sender}.`
        : 'Mail goes out through your own Amazon SES account. Paste an access key and choose who mail comes from.',
    },
    {
      id: 'domain',
      title: 'Add your domain',
      done: data.domains.length > 0,
      detail:
        data.domains.length > 0
          ? `${data.domains.map((d) => d.name).join(', ')}`
          : 'Send from your own domain (like yourcompany.com) with DKIM, SPF and DMARC, so mail lands in inboxes.',
    },
    {
      id: 'dns',
      title: 'Publish the DNS records',
      done: Boolean(verifiedDomain),
      detail: verifiedDomain
        ? `${verifiedDomain.name} is verified.`
        : firstDomain
          ? `Add the records for ${firstDomain.name} at your DNS provider. ee checks every minute and tells you when Amazon sees them.`
          : 'After adding a domain you get four records to copy into your DNS provider.',
    },
    {
      id: 'test',
      title: 'Send a test email',
      done: data.sentAny,
      detail: data.sentAny
        ? 'Mail has gone out. Every send is in Logs.'
        : `A real email to ${data.me.email}, so you see what recipients see.`,
    },
  ])

  const eventsCopy: Record<string, string> = {
    not_set_up: 'Not set up yet.',
    waiting:
      'Waiting for Amazon SNS to confirm the subscription. This usually takes under a minute once Amazon can reach this server.',
    ready: 'On. Deliveries, bounces, complaints, opens and clicks appear in Logs.',
    failed: 'Not working.',
  }

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<svelte:head><title>{docTitle('Email setup')}</title></svelte:head>

<div class="grid gap-x-10 gap-y-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
  <section aria-labelledby="setup-heading">
    <SectionHeader
      title="Set up"
      description="Four steps; each one tells you what to do next."
      testid="email-setup"
    />
    <span id="setup-heading" class="sr-only">Set up</span>
    <ol
      class="mt-4 divide-y divide-border rounded-lg border border-border"
      data-testid="email-checklist"
    >
      {#each steps as step, i (step.id)}
        <li
          class="flex gap-4 px-4 py-4 sm:px-5"
          data-testid={`email-step-${step.id}`}
          data-done={step.done}
        >
          <span
            class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium {step.done
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border text-muted-foreground'}"
            aria-hidden="true"
            >{#if step.done}<Check class="size-3.5" />{:else}{i + 1}{/if}</span
          >
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-medium">
              {step.title}<span class="sr-only">{step.done ? ' (done)' : ' (to do)'}</span>
            </h3>
            <p class="mt-0.5 text-sm text-muted-foreground">{step.detail}</p>

            {#if step.id === 'connect'}
              {#if !account}
                {#if isAdmin}
                  <div class="mt-4"><SesConnectForm /></div>
                {:else}
                  <p class="mt-2 text-sm text-muted-foreground">
                    The owner or an admin connects Amazon SES.
                  </p>
                {/if}
              {:else if isAdmin}
                {#if changingKeys}
                  <div class="mt-4">
                    <SesConnectForm
                      initialRegion={account.region}
                      initialSender={account.sender}
                      submitLabel="Save and send me a test email"
                    />
                  </div>
                {:else}
                  <Button
                    class="mt-3"
                    size="sm"
                    variant="outline"
                    onclick={() => (changingKeys = true)}>Change keys or default sender</Button
                  >
                {/if}
              {/if}
            {:else if step.id === 'domain' && account && !step.done && isAdmin}
              <Button
                class="mt-3"
                size="sm"
                href="/m/email/domains"
                data-testid="email-step-add-domain">Add a domain</Button
              >
            {:else if step.id === 'dns' && firstDomain && !step.done}
              <Button
                class="mt-3"
                size="sm"
                href={`/m/email/domains/${firstDomain.id}`}
                data-testid="email-step-dns">See the DNS records</Button
              >
            {:else if step.id === 'test' && account && isAdmin}
              <form
                method="POST"
                action="?/test"
                class="mt-3 flex flex-wrap items-center gap-2"
                use:enhance={() => {
                  busy = 'test'
                  return async ({ update }) => {
                    await update()
                    busy = null
                  }
                }}
              >
                {#if data.senders.length > 1}
                  <label class="sr-only" for="test-from">From</label>
                  <select
                    id="test-from"
                    name="from"
                    class="h-8 rounded-md border border-input bg-transparent px-2 text-[13px]"
                  >
                    {#each data.senders as s (s.address)}<option
                        value={s.address}
                        selected={s.isDefault}>{s.address}</option
                      >{/each}
                  </select>
                {/if}
                <Button
                  type="submit"
                  size="sm"
                  variant={step.done ? 'outline' : 'default'}
                  disabled={busy === 'test'}
                  data-testid="email-send-test">Send a test email to {data.me.email}</Button
                >
              </form>
              {#if feedback('test')?.ok}
                <p class="mt-2 text-sm" role="status" data-testid="email-test-sent">
                  Sent to {feedback('test')?.sentTo}.
                  <a class="underline underline-offset-4" href={resolve('/m/email/logs')}
                    >See it in Logs</a
                  >
                </p>
              {:else if feedback('test')?.error}
                <p class="mt-2 text-sm text-destructive" role="alert">{feedback('test')?.error}</p>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  </section>

  <aside class="flex flex-col gap-6" aria-label="Account">
    <div>
      <SectionHeader title="Amazon SES account" />
      {#if account}
        <dl
          class="mt-3 divide-y divide-border rounded-lg border border-border text-sm"
          data-testid="email-account"
        >
          <div class="flex justify-between gap-4 px-4 py-2.5">
            <dt class="text-muted-foreground">Region</dt>
            <dd>{account.region}</dd>
          </div>
          <div class="flex justify-between gap-4 px-4 py-2.5">
            <dt class="text-muted-foreground">Default sender</dt>
            <dd class="min-w-0 truncate">{account.sender}</dd>
          </div>
          <div class="px-4 py-2.5">
            <div class="flex justify-between gap-4">
              <dt class="text-muted-foreground">Sending to</dt>
              <dd>
                {account.sandbox === null
                  ? '—'
                  : account.sandbox
                    ? 'Verified addresses only'
                    : 'Anyone'}
              </dd>
            </div>
            {#if account.sandbox}
              <p class="mt-1.5 text-xs text-muted-foreground" data-testid="email-sandbox">
                Your account is in Amazon's sandbox: it can only mail addresses you verified at
                Amazon.
                <a
                  class="underline underline-offset-4"
                  href="https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html"
                  target="_blank"
                  rel="noopener noreferrer">Request production access</a
                > to mail anyone.
              </p>
            {/if}
            {#if account.accountError}<p class="mt-1.5 text-xs text-destructive">
                {account.accountError}
              </p>{/if}
          </div>
        </dl>

        <div
          class="mt-4 rounded-lg border border-border px-4 py-3 text-sm"
          data-testid="email-events"
          data-status={account.events.status}
        >
          <h3 class="font-medium">Delivery tracking</h3>
          <p class="mt-1 text-muted-foreground">{eventsCopy[account.events.status]}</p>
          {#if account.events.error}<p class="mt-1 text-destructive" role="alert">
              {account.events.error}
            </p>{/if}
          {#if feedback('events')?.error}<p class="mt-1 text-destructive" role="alert">
              {feedback('events')?.error}
            </p>{/if}
          {#if isAdmin && account.events.status !== 'ready'}
            <form method="POST" action="?/events" class="mt-2" use:enhance>
              <Button type="submit" size="sm" variant="outline">Set up again</Button>
            </form>
          {/if}
        </div>
      {:else}
        <p class="mt-3 text-sm text-muted-foreground">Not connected yet.</p>
      {/if}
    </div>

    {#if account}
      <div>
        <SectionHeader title="Recent mail">
          {#snippet actions()}
            <a
              class="text-[13px] text-muted-foreground underline-offset-4 hover:underline"
              href={resolve('/m/email/logs')}>All logs</a
            >
          {/snippet}
        </SectionHeader>
        {#if data.recent.length === 0}
          <p class="mt-3 text-sm text-muted-foreground">Nothing sent yet.</p>
        {:else}
          <ul class="mt-3 divide-y divide-border rounded-lg border border-border">
            {#each data.recent as m (m.id)}
              <li>
                <a
                  class="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
                  href={resolve(`/m/email/logs/${m.id}`)}
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm">{m.subject}</span>
                    <span class="block truncate text-xs text-muted-foreground"
                      >{m.to} · {when(m.createdAt)}</span
                    >
                  </span>
                  <MessageStatus status={m.status} />
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </aside>
</div>
