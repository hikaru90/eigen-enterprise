<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import { appHref } from '$lib/shell/href'
  import type { ModuleSettingsSlot } from '$lib/shell/module-settings'

  /** Hosts whatever a module put in its settings slot (links to existing settings surfaces). */
  let { slot }: { slot: ModuleSettingsSlot | null } = $props()
</script>

{#if !slot}
  <p class="text-sm text-foreground/55" data-testid="module-settings-empty">
    This module has no settings yet.
  </p>
{:else}
  {#if slot.note}<p class="mb-3 text-sm text-foreground/65">{slot.note}</p>{/if}
  {#if slot.links.length > 0}
    <ul class="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {#each slot.links as link (link.label)}
        <li>
          <a
            href={appHref(link.href)}
            class="group flex min-w-0 items-center gap-3 px-4 py-3 transition-colors outline-none hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{link.label}</span>
              <span class="block truncate text-xs text-foreground/55">{link.text}</span>
            </span>
            <ArrowUpRight
              class="size-4 shrink-0 text-foreground/35 group-hover:text-foreground/70"
              aria-hidden="true"
            />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
