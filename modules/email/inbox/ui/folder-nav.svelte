<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- hrefs come from the page, built on resolve('/m/email/inbox') */
  import type { Folder } from '../types'
  import type { FolderView } from '../view'

  /** The mailbox's folders with unread counts (Sent shows none: it is never unread). */
  let { folders, current, href }: { folders: FolderView[]; current: Folder; href: (folder: Folder) => string } = $props()
</script>

<nav aria-label="Folders" class="flex flex-wrap gap-1" data-testid="inbox-folders">
  {#each folders as f (f.folder)}
    {@const showUnread = f.folder !== 'sent' && f.unread > 0}
    <a
      href={href(f.folder)}
      aria-current={current === f.folder ? 'page' : undefined}
      data-testid={`inbox-folder-${f.folder}`}
      class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 {current ===
      f.folder
        ? 'bg-muted font-medium text-foreground'
        : 'text-muted-foreground hover:text-foreground'}"
    >
      {f.label}
      {#if showUnread}
        <span class="rounded-full bg-primary/10 px-1.5 text-[11px] font-semibold text-primary tabular-nums" data-testid={`inbox-folder-${f.folder}-unread`}
          >{f.unread}<span class="sr-only">&nbsp;unread</span></span
        >
      {/if}
    </a>
  {/each}
</nav>
