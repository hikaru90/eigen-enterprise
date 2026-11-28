<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import Bell from '@lucide/svelte/icons/bell'
  import { onMount } from 'svelte'
  import { afterNavigate } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import * as Popover from '$lib/components/ui/popover'
  import { appHref } from '$lib/shell/href'

  /**
   * The top bar's bell (wishes f3fc516e, 3c1481b9): what needs me — team
   * questions asked of me, tasks given to me, news on tasks I gave out, my AI
   * co-workers' results — with the unread count. A client of
   * notifications.inbox / notifications.mark_read (GET / POST /api/notifications).
   * It reloads on every navigation and when the tab comes back into view, so a
   * new question shows up without checking Memory › Questions.
   */
  type Item = {
    key: string
    kind: string
    title: string
    detail: string
    href: string
    at: string
    unread: boolean
  }
  type Inbox = { items: Item[]; unread: number }

  let open = $state(false)
  let inbox = $state<Inbox | null>(null)
  let error = $state<string | null>(null)

  async function apply(res: Response) {
    const body = await res.json()
    if (!res.ok) throw new Error(body?.message ?? `The inbox answered ${res.status}`)
    inbox = body as Inbox
    error = null
  }

  async function load() {
    try {
      await apply(await fetch('/api/notifications'))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function markRead(keys: string[]) {
    if (keys.length === 0) return
    try {
      await apply(
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keys }),
        }),
      )
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') void load()
  }

  onMount(() => {
    void load()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  })
  afterNavigate(() => void load())

  const unreadKeys = $derived(inbox?.items.filter((i) => i.unread).map((i) => i.key) ?? [])
  const count = $derived(inbox?.unread ?? 0)
  const when = (at: string) =>
    new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-card text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-primary data-[state=open]:text-primary-foreground"
    aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
    data-testid="notification-bell"
  >
    <Bell class="size-4" aria-hidden="true" strokeWidth={1.75} />
    {#if count > 0}
      <span
        class="pointer-events-none absolute -top-0.5 -right-0.5 inline-grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 font-mono text-[10px] leading-none text-white"
        data-testid="notification-bell-count"
        aria-hidden="true">{count > 99 ? '99+' : count}</span
      >
    {/if}
  </Popover.Trigger>
  <Popover.Content
    align="end"
    side="bottom"
    sideOffset={6}
    class="w-[min(24rem,calc(100vw-1.5rem))] p-0"
  >
    <div class="flex items-center justify-between gap-2 border-b px-4 py-3">
      <h2 class="text-sm font-medium">Needs you</h2>
      {#if unreadKeys.length > 0}
        <button
          type="button"
          class="text-xs text-muted-foreground hover:text-foreground"
          data-testid="notification-bell-mark-all"
          onclick={() => void markRead(unreadKeys)}>Mark all read</button
        >
      {/if}
    </div>
    {#if error}
      <div class="p-3">
        <ErrorNotice
          class="text-xs"
          {error}
          attempted="Loading your notifications (GET /api/notifications)"
        />
      </div>
    {:else if inbox && inbox.items.length === 0}
      <p class="px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing needs you right now.
      </p>
    {:else if inbox}
      <ul class="max-h-[60vh] overflow-y-auto py-1" data-testid="notification-bell-list">
        {#each inbox.items as item (item.key)}
          <li>
            <a
              href={appHref(item.href as Parameters<typeof appHref>[0])}
              class="flex gap-3 px-4 py-2.5 hover:bg-accent"
              data-testid="notification-bell-item"
              data-kind={item.kind}
              data-unread={item.unread}
              onclick={() => {
                open = false
                if (item.unread) void markRead([item.key])
              }}
            >
              <span
                class="mt-1.5 size-2 shrink-0 rounded-full {item.unread
                  ? 'bg-destructive'
                  : 'bg-transparent'}"
                aria-hidden="true"
              ></span>
              <span class="min-w-0 flex-1">
                <span class="block text-sm {item.unread ? 'font-medium' : ''}">{item.title}</span>
                <span class="block truncate text-sm text-muted-foreground">{item.detail}</span>
                <span class="block text-xs text-muted-foreground">{when(item.at)}</span>
              </span>
            </a>
          </li>
        {/each}
      </ul>
      <div class="border-t px-4 py-2 text-right">
        <a
          href={resolve('/m/memory/questions')}
          class="text-xs text-muted-foreground hover:text-foreground"
          onclick={() => (open = false)}>All questions</a
        >
      </div>
    {/if}
  </Popover.Content>
</Popover.Root>
