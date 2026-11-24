<script lang="ts">
  import type { PageProps } from './$types'
  /* eslint-disable svelte/no-navigation-without-resolve -- the filter/paging links carry a query string on resolve('/m/email/logs') */
  import { resolve } from '$app/paths'
  import MessageStatus from '$lib/components/email/message-status.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { docTitle } from '$lib/shell/title'
  import { nextSort, sortRows, type SortState } from '$lib/table/sort'
  import SortableHead from '$lib/table/sortable-head.svelte'
  import {
    MESSAGE_STATUSES,
    SOURCE_LABEL,
    STATUS_LABEL,
  } from '../../../../../../modules/email/platform/status'

  let { data }: PageProps = $props()
  const base = resolve('/m/email/logs')
  const olderHref = $derived(
    `${base}?` +
      [
        ['status', data.filter.status],
        ['q', data.filter.q],
        ['before', data.older ?? ''],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&'),
  )
  type ColKey = 'to' | 'subject' | 'from' | 'source' | 'status' | 'when'
  let sort = $state<SortState<ColKey>>(null)
  const sortBy = (key: ColKey) => (sort = nextSort(sort, key))
  const rows = $derived(
    sortRows(data.messages, sort, {
      to: (m) => m.to,
      subject: (m) => m.subject,
      from: (m) => m.from,
      source: (m) => SOURCE_LABEL[m.source] ?? m.source,
      status: (m) => STATUS_LABEL[m.status] ?? m.status,
      when: (m) =>
        new Date(m.scheduledAt && m.status === 'scheduled' ? m.scheduledAt : m.createdAt),
    }),
  )
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<svelte:head><title>{docTitle('Logs', 'Email')}</title></svelte:head>

<SectionHeader
  title="Logs"
  description="Every mail your company sent — from the assistant, your apps, tests and the system — and what happened to it."
/>

<form
  method="GET"
  action={base}
  class="mt-5 flex flex-wrap items-center gap-2"
  data-testid="logs-filter"
>
  <Input
    dictation={false}
    name="q"
    value={data.filter.q}
    placeholder="Search recipient or subject"
    class="h-9 w-64"
  />
  <label class="sr-only" for="logs-status">Status</label>
  <select
    id="logs-status"
    name="status"
    class="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
  >
    <option value="" selected={data.filter.status === ''}>All statuses</option>
    {#each MESSAGE_STATUSES as s (s)}<option value={s} selected={data.filter.status === s}
        >{STATUS_LABEL[s]}</option
      >{/each}
  </select>
  <Button type="submit" variant="outline" size="sm">Filter</Button>
  {#if data.filter.q || data.filter.status}<a
      class="text-[13px] text-muted-foreground hover:text-foreground"
      href={base}>Clear</a
    >{/if}
</form>

{#if data.messages.length === 0}
  <p class="mt-6 text-sm text-muted-foreground" data-testid="logs-empty">
    {data.filter.q || data.filter.status ? 'No mail matches.' : 'Nothing sent yet.'}
  </p>
{:else}
  <div class="mt-5 overflow-x-auto rounded-lg border border-border">
    <table class="w-full min-w-[48rem] text-left text-sm" data-testid="logs-table">
      <thead class="border-b border-border text-xs text-muted-foreground">
        <tr>
          <SortableHead label="Recipient" sortKey="to" {sort} class="px-4 py-2.5" onsort={sortBy} />
          <SortableHead
            label="Subject"
            sortKey="subject"
            {sort}
            class="px-4 py-2.5"
            onsort={sortBy}
          />
          <SortableHead label="From" sortKey="from" {sort} class="px-4 py-2.5" onsort={sortBy} />
          <SortableHead
            label="Sent by"
            sortKey="source"
            {sort}
            class="px-4 py-2.5"
            onsort={sortBy}
          />
          <SortableHead
            label="Status"
            sortKey="status"
            {sort}
            class="px-4 py-2.5"
            onsort={sortBy}
          />
          <SortableHead label="When" sortKey="when" {sort} class="px-4 py-2.5" onsort={sortBy} />
        </tr>
      </thead>
      <tbody class="divide-y divide-border">
        {#each rows as m (m.id)}
          <tr class="hover:bg-muted/50" data-testid="log-row">
            <td class="max-w-56 truncate px-4 py-2.5">
              <a class="hover:underline" href={resolve(`/m/email/logs/${m.id}`)}>{m.to}</a>
            </td>
            <td class="max-w-72 truncate px-4 py-2.5">{m.subject}</td>
            <td class="max-w-48 truncate px-4 py-2.5 text-muted-foreground">{m.from}</td>
            <td class="px-4 py-2.5 text-muted-foreground"
              >{SOURCE_LABEL[m.source] ?? m.source}{m.apiKeyName ? ` · ${m.apiKeyName}` : ''}</td
            >
            <td class="px-4 py-2.5"><MessageStatus status={m.status} /></td>
            <td class="px-4 py-2.5 whitespace-nowrap text-muted-foreground"
              >{when(m.scheduledAt && m.status === 'scheduled' ? m.scheduledAt : m.createdAt)}</td
            >
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if data.older}
    <a
      class="mt-3 inline-block text-[13px] text-muted-foreground hover:text-foreground"
      href={olderHref}>Older mail →</a
    >
  {/if}
{/if}
