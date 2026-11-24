<script lang="ts">
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings → Plugins → Company modules (plan/phase-upgrades-u2.md §8): a
   * client of the modules.* tools. Where each module stands and the kernel's
   * own sentence on why; the owner's one-time sharing OK; the deploy that
   * waits for an admin's click; removal (code and data stay).
   */
  let { data, form }: PageProps = $props()

  let confirmingRemove = $state<string | null>(null)

  const STATE: Record<string, string> = {
    unpublished: 'Not running yet',
    publishing: 'Publishing',
    deploying: 'Deploying',
    connecting: 'Starting',
    running: 'Running',
    failed: 'Switched off',
    off: 'Off',
  }
  const resultFor = (id: string | null) => (form && 'id' in form && form.id === id ? form : null)
</script>

<svelte:head>
  <title>{docTitle('Company modules', 'Settings')}</title>
</svelte:head>

<h2 class="text-base font-semibold tracking-tight">Company modules</h2>
<p class="mt-1 text-sm text-foreground/60">
  Modules built for your company — by you or by the assistant. Each one runs in its own sandbox,
  acts only as the person using it, and keeps its data in your company's files. Switch them on and
  off in <a class="underline" href={resolve('/settings/modules')}>Plugins</a>.
</p>

{#if !data.sharing}
  <section class="mt-6 rounded-lg border border-border p-4" data-testid="company-modules-sharing">
    <p class="text-sm font-medium">
      Modules you build here are open source (Apache-2.0) and shared with eigenEnterprise.
    </p>
    {#if data.isOwner}
      <form method="post" action="?/acceptSharing" use:enhance class="mt-3">
        <Button type="submit" size="sm" data-testid="company-modules-accept-sharing">OK</Button>
      </form>
    {:else}
      <p class="mt-2 text-xs text-foreground/60">The owner gives this OK once; until then nothing is published.</p>
    {/if}
    {#if form && form.action === 'acceptSharing' && 'error' in form && form.error}
      <ErrorNotice class="mt-3 text-xs" error={form.error} agent={'agent' in form ? form.agent : null} attempted="Agreeing to share modules" />
    {/if}
  </section>
{/if}

{#if data.modules.length === 0}
  <p class="mt-8 text-sm text-foreground/60" data-testid="company-modules-empty">
    No modules yet. Ask the assistant to build one.
  </p>
{:else}
  <ul class="mt-8 space-y-3" data-testid="company-modules">
    {#each data.modules as mod (mod.id)}
      {@const result = resultFor(mod.id)}
      <li class="rounded-lg border border-border p-4" data-testid={`company-module-${mod.id}`}>
        <div class="flex flex-wrap items-center gap-2">
          <h4 class="text-sm font-medium">{mod.name}</h4>
          <span class="text-xs text-foreground/70" data-testid="company-module-state" data-state={mod.state}
            >{STATE[mod.state] ?? mod.state}</span
          >
          {#if mod.version}<span class="text-xs text-foreground/50">v{mod.version}</span>{/if}
          {#if mod.commit}<span class="font-mono text-xs text-foreground/50">{mod.commit.slice(0, 12)}</span>{/if}
        </div>
        {#if mod.sentence}
          <p class="mt-1 text-xs text-foreground/70" data-testid="company-module-sentence">{mod.sentence}</p>
        {/if}
        {#if mod.pendingDeploy}
          <form method="post" action="?/deploy" use:enhance class="mt-3 flex items-center gap-2 text-xs">
            <input type="hidden" name="id" value={mod.id} />
            <input type="hidden" name="commit" value={mod.pendingDeploy.commit} />
            <span class="text-foreground/70"
              >Waiting for an admin to deploy {mod.pendingDeploy.commit.slice(0, 12)}.</span
            >
            <Button type="submit" size="sm" data-testid="company-module-deploy">Deploy</Button>
          </form>
        {/if}
        <div class="mt-3 flex gap-2">
          {#if confirmingRemove === mod.id}
            <form method="post" action="?/remove" use:enhance class="flex items-center gap-2 text-xs">
              <input type="hidden" name="id" value={mod.id} />
              <span>Remove {mod.name} from this server? Its code and its data are kept.</span>
              <Button type="submit" size="sm" variant="destructive" data-testid="company-module-remove-confirm">Remove</Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => (confirmingRemove = null)}>Cancel</Button>
            </form>
          {:else}
            <Button type="button" size="sm" variant="ghost" onclick={() => (confirmingRemove = mod.id)} data-testid="company-module-remove"
              >Remove…</Button
            >
          {/if}
        </div>
        {#if result && 'error' in result && result.error}
          <ErrorNotice class="mt-3 text-xs" error={result.error} agent={'agent' in result ? result.agent : null} attempted={`Changing the module ${mod.id}`} />
        {:else if result && 'ok' in result && result.ok}
          <p class="mt-3 text-xs text-foreground/60" role="status">Done.</p>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
