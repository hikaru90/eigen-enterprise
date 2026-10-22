<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import GitBranch from '@lucide/svelte/icons/git-branch'
  import MessageSquare from '@lucide/svelte/icons/message-square'
  import { resolve } from '$app/paths'
  import * as Dialog from '$lib/components/ui/dialog'

  /**
   * The Add dialog behind the Add button on the Website module's front page: the
   * two ways to create or connect an app. Static sites aren't a separate
   * path — they're an app like any other, built with the agent in chat. The chat
   * option only fills the composer's draft (?prefill=) — nothing is sent
   * automatically.
   */

  let {
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  } = $props()

  const BUILD_PREFILL = 'Build me an app: '

  const options = [
    {
      icon: MessageSquare,
      href: `/?prefill=${encodeURIComponent(BUILD_PREFILL)}`,
      title: 'Build it with chat',
      description: 'Describe an app or website and build it with your agent.',
    },
    {
      icon: GitBranch,
      href: resolve('/m/website/apps/new'),
      title: 'Connect a repo',
      description:
        'Public or private GitHub repositories. Private repos use a read-only deploy key.',
    },
  ]
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content class="max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Add an app</Dialog.Title>
      <Dialog.Description>Where should the next app come from?</Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2">
      <!-- eslint-disable svelte/no-navigation-without-resolve -- the chat draft
           travels as a query param (?prefill=), which resolve() can't carry. -->
      {#each options as option (option.href)}
        <a
          href={option.href}
          class="group flex items-start gap-3 rounded-lg border border-border p-4 transition-colors hover:border-foreground/25 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          data-testid="add-app-option"
        >
          <span class="rounded-md border border-border bg-muted/40 p-2"
            ><option.icon class="size-5" strokeWidth={1.5} /></span
          >
          <span class="flex flex-1 flex-col gap-1">
            <span class="text-sm font-medium">{option.title}</span>
            <span class="text-xs leading-relaxed text-foreground/60">{option.description}</span>
          </span>
          <ArrowUpRight class="mt-1 size-4 text-foreground/40 group-hover:text-foreground" />
        </a>
      {/each}
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    </div>
  </Dialog.Content>
</Dialog.Root>
