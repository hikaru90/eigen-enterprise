<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import MessageStatus from '$lib/components/email/message-status.svelte'
  import { Button } from '$lib/components/ui/button'
  import { SOURCE_LABEL, STATUS_LABEL, type MessageStatus as Status } from '../../../../../../../modules/email/platform/status'

  let { data, form }: PageProps = $props()
  const m = $derived(data.message)
  let view = $state<'html' | 'text'>('html')
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

  /** The detail of an event, in words (bounce diagnostic, clicked link …). */
  function describe(detail: Record<string, unknown> | null): string | null {
    if (!detail) return null
    const parts: string[] = []
    if (typeof detail.bounceType === 'string') parts.push(`${detail.bounceType} bounce${typeof detail.bounceSubType === 'string' ? ` (${detail.bounceSubType})` : ''}`)
    if (typeof detail.diagnostic === 'string') parts.push(detail.diagnostic)
    if (typeof detail.feedbackType === 'string') parts.push(`Feedback: ${detail.feedbackType}`)
    if (typeof detail.link === 'string') parts.push(detail.link)
    for (const k of ['reason', 'error', 'delayType']) if (typeof detail[k] === 'string') parts.push(detail[k] as string)
    if (typeof detail.at === 'string') parts.push(`For ${when(detail.at)}`)
    return parts.length > 0 ? parts.join(' · ') : null
  }
</script>

<div class="mt-8">
  <a class="text-[13px] text-muted-foreground hover:text-foreground" href={resolve('/m/email/logs')}>← Back to logs</a>
  <div class="mt-2 flex flex-wrap items-center gap-3">
    <h2 class="text-base font-semibold tracking-tight" data-testid="log-subject">{m.subject}</h2>
    <MessageStatus status={m.status} />
  </div>
</div>

<div class="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
  <div class="min-w-0">
    <dl class="divide-y divide-border rounded-lg border border-border text-sm">
      {#each [['To', m.to], ['From', m.from], ['Reply to', m.replyTo], ['Sent by', `${SOURCE_LABEL[m.source] ?? m.source}${m.apiKeyName ? ` · key ${m.apiKeyName}` : ''}`], ['Created', when(m.createdAt)], ['Scheduled for', m.scheduledAt ? when(m.scheduledAt) : null], ['Amazon message id', m.sesMessageId]] as [label, value] (label)}
        {#if value}
          <div class="flex gap-4 px-4 py-2.5">
            <dt class="w-36 shrink-0 text-muted-foreground">{label}</dt>
            <dd class="min-w-0 break-all">{value}</dd>
          </div>
        {/if}
      {/each}
    </dl>
    {#if m.error}<p class="mt-3 text-sm text-destructive" role="alert">{m.error}</p>{/if}

    {#if m.status === 'scheduled' && data.email.isAdmin}
      <form method="POST" action="?/cancel" class="mt-4" use:enhance>
        <Button type="submit" variant="outline" size="sm" data-testid="log-cancel">Cancel this send</Button>
        {#if form?.action === 'cancel' && 'error' in form}<p class="mt-2 text-sm text-destructive">{form.error}</p>{/if}
      </form>
    {/if}

    <section class="mt-8" aria-labelledby="content-heading">
      <div class="flex items-center justify-between gap-3">
        <h3 id="content-heading" class="text-sm font-medium">Content</h3>
        {#if m.contentStored}
          <div class="flex gap-1 text-[13px]">
            <button type="button" class="rounded px-2 py-1 {view === 'html' ? 'bg-muted font-medium' : 'text-muted-foreground'}" onclick={() => (view = 'html')}>HTML</button>
            <button type="button" class="rounded px-2 py-1 {view === 'text' ? 'bg-muted font-medium' : 'text-muted-foreground'}" onclick={() => (view = 'text')}>Text</button>
          </div>
        {/if}
      </div>
      {#if !m.contentStored}
        <p class="mt-2 text-sm text-muted-foreground" data-testid="log-content-private">
          System mail (sign-in codes, notifications) keeps no body in the log — it may hold a code.
        </p>
      {:else if view === 'html'}
        <iframe
          title="Email content"
          class="mt-3 h-[28rem] w-full rounded-lg border border-border bg-white"
          sandbox=""
          srcdoc={m.html ?? ''}
          data-testid="log-content-html"
        ></iframe>
      {:else}
        <pre class="mt-3 max-h-[28rem] overflow-auto rounded-lg border border-border px-4 py-3 text-xs whitespace-pre-wrap">{m.text}</pre>
      {/if}
    </section>
  </div>

  <section aria-labelledby="timeline-heading">
    <h3 id="timeline-heading" class="text-sm font-medium">What happened</h3>
    <ol class="mt-3 border-l border-border pl-5" data-testid="log-timeline">
      {#each data.events as e (e.id)}
        <li class="relative pb-5 last:pb-0" data-testid={`log-event-${e.status}`}>
          <span class="absolute top-1.5 -left-[1.4rem] size-2 rounded-full bg-border ring-4 ring-background" aria-hidden="true"></span>
          <p class="text-sm font-medium">{STATUS_LABEL[e.status as Status] ?? e.status}</p>
          <p class="text-xs text-muted-foreground">{when(e.at)}</p>
          {#if describe(e.detail)}<p class="mt-0.5 text-xs break-all text-muted-foreground">{describe(e.detail)}</p>{/if}
        </li>
      {/each}
    </ol>
    {#if m.status === 'sent'}
      <p class="mt-4 text-xs text-muted-foreground">Delivery, opens and bounces show up here once Amazon reports them (Delivery tracking on the Overview).</p>
    {/if}
  </section>
</div>
