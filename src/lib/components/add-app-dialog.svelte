<script lang="ts">
  import { resolve } from '$app/paths'
  import * as Dialog from '$lib/components/ui/dialog'

  /**
   * The Add dialog behind the "+" card on the Apps overview: three ways to put
   * something new on this server. The chat option only fills the composer's
   * draft (?prefill=) — nothing is sent automatically.
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
      href: `/?prefill=${encodeURIComponent(BUILD_PREFILL)}`,
      title: 'Build it with chat',
      description: 'Say what it should do; the AI builds and deploys it with you.',
    },
    {
      href: resolve('/m/website/apps/new'),
      title: 'Connect a repo',
      description: 'Deploy a GitHub repo — public, or private with a deploy key.',
    },
    {
      href: resolve('/m/website/site'),
      title: 'Static site',
      description: 'Your company site from pages, under its own domain.',
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
          class="flex flex-col gap-0.5 rounded-md border border-border p-3 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          data-testid="add-app-option"
        >
          <span class="text-sm font-medium">{option.title}</span>
          <span class="text-xs text-foreground/60">{option.description}</span>
        </a>
      {/each}
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    </div>
  </Dialog.Content>
</Dialog.Root>
