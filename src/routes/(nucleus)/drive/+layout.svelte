<script lang="ts">
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import FolderLockIcon from '@lucide/svelte/icons/folder-lock'
  import HardDriveIcon from '@lucide/svelte/icons/hard-drive'
  import MessageSquareIcon from '@lucide/svelte/icons/message-square'
  import TrashIcon from '@lucide/svelte/icons/trash-2'
  import UsersIcon from '@lucide/svelte/icons/users'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import StatusPill from '$lib/components/page/status-pill.svelte'
  import { driveSection, sourceSection, type DriveSection } from '$lib/drive/sections'

  /**
   * The Drive area as an app (P-3): full width and height, no centred frame.
   * A left rail — the one `h1`, status, My drive · Shared with me · Messages
   * · one section per read-only source root (e.g. GitHub, listed from the
   * roots that exist) · Archived · Trash, the storage note — and the browser
   * or file view beside it.
   * On narrow screens the rail becomes a bar above the content.
   */
  let { data, children }: { data: LayoutData; children: Snippet } = $props()

  type Section = {
    id: DriveSection
    label: string
    href:
      | '/drive'
      | '/drive/shared'
      | '/drive/messages'
      | '/drive/archived'
      | '/drive/trash'
      | `/drive/folder/${string}`
    icon: typeof HardDriveIcon
  }
  const before: Section[] = [
    { id: 'mine', label: 'My drive', href: '/drive', icon: HardDriveIcon },
    { id: 'shared', label: 'Shared with me', href: '/drive/shared', icon: UsersIcon },
    { id: 'messages', label: 'Messages', href: '/drive/messages', icon: MessageSquareIcon },
  ]
  const after: Section[] = [
    { id: 'archived', label: 'Archived', href: '/drive/archived', icon: ArchiveIcon },
    { id: 'trash', label: 'Trash', href: '/drive/trash', icon: TrashIcon },
  ]
  const sections = $derived<Section[]>([
    ...before,
    ...data.sources.map((s) => ({
      id: sourceSection(s.source),
      label: s.name,
      href: `/drive/folder/${s.folderId}` as const,
      icon: FolderLockIcon,
    })),
    ...after,
  ])
  const rootHref = $derived((page.data as { root?: { href: string } }).root?.href ?? null)
  const current = $derived(driveSection(page.url.pathname, rootHref, data.sources))
</script>

<div class="flex min-h-0 w-full flex-1 flex-col md:flex-row" data-testid="drive-page">
  <aside
    class="flex shrink-0 flex-col gap-3 border-b border-border bg-muted/20 px-4 py-4 md:w-60 md:gap-6 md:border-r md:border-b-0 md:px-3 md:py-6"
    data-testid="drive-rail"
  >
    <div class="flex items-center gap-2 md:px-2">
      <h1 class="text-lg font-semibold tracking-tight">{data.drive.name}</h1>
      <StatusPill label={data.drive.active ? 'Active' : 'Not active'} on={data.drive.active} />
    </div>
    <nav
      aria-label="Drive sections"
      class="-mx-1 flex gap-1 overflow-x-auto md:mx-0 md:flex-col md:overflow-visible"
      data-testid="drive-nav"
    >
      {#each sections as section (section.id)}
        {@const Icon = section.icon}
        <a
          href={resolve(section.href)}
          aria-current={current === section.id ? 'page' : undefined}
          class="flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors {current ===
          section.id
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
          data-testid="drive-tab-{section.id}"
        >
          <Icon class="size-4 shrink-0" aria-hidden="true" />
          {section.label}
        </a>
      {/each}
    </nav>
    <div class="hidden flex-col gap-1 px-2 text-xs text-muted-foreground md:mt-auto md:flex">
      <span class="flex items-center gap-1.5">
        <HardDriveIcon class="size-3.5" aria-hidden="true" />
        <span data-testid="drive-storage">{data.drive.storageUsed} used</span>
      </span>
      <span>Files stay on this company's server.</span>
    </div>
  </aside>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {@render children()}
  </div>
</div>
