<script lang="ts">
  import type { PageProps } from './$types'
  import type { PluginRef, PluginRow } from './+page.server'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Switch } from '$lib/components/ui/switch'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings → Plugins: every plugin, on or off, and its switch. Switching on
   * is direct; switching off asks first and says what goes (the sidebar entry
   * dims, the agent loses its tools) and that its data is kept. The kernel
   * decides: what it refuses is shown on the plugin, in its words. Official
   * plugins are only switched on or off; a company's own plugins get their
   * own group once there are any.
   */
  let { data, form }: PageProps = $props()

  const official = $derived(data.plugins.filter((p) => p.origin === 'official'))
  const company = $derived(data.plugins.filter((p) => p.origin === 'company'))

  /** The plugin whose switch-off is being confirmed. */
  let confirming = $state<string | null>(null)
  /** The plugin whose switch is being sent. */
  let pending = $state<string | null>(null)
  const activateForms: Record<string, HTMLFormElement> = {}

  function requestSwitch(plugin: PluginRow, next: boolean) {
    if (pending) return
    if (next) {
      confirming = null
      activateForms[plugin.id]?.requestSubmit()
    } else {
      confirming = plugin.id
    }
  }

  const sending = (id: string) => () => {
    pending = id
    return async ({ update }: { update: () => Promise<void> }) => {
      await update()
      pending = null
      confirming = null
    }
  }

  const names = (refs: PluginRef[]) => refs.map((r) => r.name).join(', ')
  const activeNames = (refs: PluginRef[]) => names(refs.filter((r) => r.active))
  const resultFor = (id: string) => (form && 'moduleId' in form && form.moduleId === id ? form : null)
</script>

<svelte:head>
  <title>{docTitle('Plugins', 'Settings')}</title>
</svelte:head>

<h2 class="text-base font-semibold tracking-tight">Plugins</h2>
<p class="mt-1 text-sm text-foreground/60">
  Everything in the sidebar is a plugin. Switch off what your company doesn't use — nothing it has stored is
  deleted, and you can switch it back on any time.
</p>

{#snippet pluginItem(plugin: PluginRow)}
  {@const result = resultFor(plugin.id)}
  <li class="rounded-lg border border-border p-4" data-testid={`plugin-${plugin.id}`}>
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <h4 class="text-sm font-medium">{plugin.name}</h4>
          <span
            class="rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground/70"
            data-testid="plugin-origin">{plugin.origin === 'official' ? 'Official' : 'Company'}</span
          >
          <span
            class={[
              'text-xs',
              plugin.active ? 'text-foreground/70' : 'text-foreground/50',
            ]}
            data-testid="plugin-state">{plugin.active ? 'On' : 'Off'}</span
          >
        </div>
        {#if plugin.description}
          <p class="text-xs text-foreground/60">{plugin.description}</p>
        {/if}
        {#if plugin.requires.length > 0}
          <p class="text-xs text-foreground/60">Needs {names(plugin.requires)}</p>
        {/if}
        {#if plugin.requiredBy.length > 0}
          <p class="text-xs text-foreground/60">Needed by {names(plugin.requiredBy)}</p>
        {/if}
      </div>
      <form
        method="post"
        action="?/activate"
        use:enhance={sending(plugin.id)}
        bind:this={activateForms[plugin.id]}
        data-testid={`plugin-activate-form-${plugin.id}`}
      >
        <input type="hidden" name="module_id" value={plugin.id} />
      </form>
      <Switch
        bind:checked={() => plugin.active, (next) => requestSwitch(plugin, next)}
        disabled={pending !== null}
        aria-label={`${plugin.name} ${plugin.active ? 'on' : 'off'}`}
        data-testid={`plugin-switch-${plugin.id}`}
        class="mt-0.5"
      />
    </div>

    {#if confirming === plugin.id}
      {@const needers = activeNames(plugin.requiredBy)}
      <form
        method="post"
        action="?/deactivate"
        use:enhance={sending(plugin.id)}
        class="mt-4 space-y-2 rounded-md bg-muted/50 p-3 text-xs"
        data-testid={`plugin-confirm-form-${plugin.id}`}
      >
        <div data-testid={`plugin-confirm-${plugin.id}`} class="space-y-2">
          <p class="text-sm font-medium">Switch off {plugin.name}?</p>
          <ul class="list-disc space-y-1 pl-4 text-foreground/70">
            <li>Its entry in the sidebar is dimmed.</li>
            <li>
              {plugin.tools.length > 0
                ? `The agent can no longer use its ${plugin.tools.length} tools.`
                : 'It gives the agent no tools.'}
            </li>
            {#if needers}
              <li class="text-destructive">
                {needers}
                {plugin.requiredBy.filter((r) => r.active).length === 1 ? 'needs' : 'need'} it: switch
                {plugin.requiredBy.filter((r) => r.active).length === 1 ? 'it' : 'them'} off first.
              </li>
            {/if}
            <li>Everything it has stored is kept. Switch it back on any time.</li>
          </ul>
          <input type="hidden" name="module_id" value={plugin.id} />
          <div class="flex gap-2 pt-1">
            <Button type="submit" size="sm" variant="destructive" disabled={pending !== null}>Switch off</Button>
            <Button type="button" size="sm" variant="ghost" onclick={() => (confirming = null)}>Cancel</Button>
          </div>
        </div>
      </form>
    {/if}

    {#if result?.error}
      <p class="mt-3 text-xs text-destructive" role="alert">{result.error}</p>
    {:else if result && 'ok' in result && result.ok}
      <p class="mt-3 text-xs text-foreground/60" role="status">
        {result.action === 'activate' ? 'Switched on.' : 'Switched off.'}
      </p>
    {/if}
  </li>
{/snippet}

<div class="mt-8 space-y-8" data-testid="settings-plugins">
  <section class="space-y-3">
    <h3 class="text-sm font-medium">Official plugins</h3>
    <p class="text-xs text-foreground/60">Shipped with eigenEnterprise. They are only switched on or off.</p>
    <ul class="space-y-3">
      {#each official as plugin (plugin.id)}
        {@render pluginItem(plugin)}
      {/each}
    </ul>
  </section>

  {#if company.length > 0}
    <section class="space-y-3" data-testid="plugins-company">
      <h3 class="text-sm font-medium">Company plugins</h3>
      <p class="text-xs text-foreground/60">Added by your company, alongside the official ones.</p>
      <ul class="space-y-3">
        {#each company as plugin (plugin.id)}
          {@render pluginItem(plugin)}
        {/each}
      </ul>
    </section>
  {/if}

  <p class="rounded-lg border border-dashed border-border p-4 text-xs text-foreground/60" data-testid="plugins-core">
    <span class="font-medium text-foreground/80">Core:</span>
    {data.core.map((c) => c.name).join(', ')}. It runs eigenEnterprise itself and cannot be switched off.
  </p>
</div>
