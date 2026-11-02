<script lang="ts">
  import type { PageData } from './$types'
  import { onMount } from 'svelte'
  import { prefersReducedMotion } from 'svelte/motion'
  import { fly } from 'svelte/transition'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import PickerBreadcrumb from '$lib/components/brand-picker/picker-breadcrumb.svelte'
  import PickerGrid from '$lib/components/brand-picker/picker-grid.svelte'
  import { pickerQuery, type PreviewMode } from '$lib/components/brand-picker/types'
  import ActivationNotice from './activation-notice.svelte'

  /**
   * The brand picker (plan/phase-brand-picker.md §3.3, owner direction
   * "choose your style like an artist on Spotify"): genres → styles →
   * variants, one grid per level, the URL (`?style=`) is the state so the
   * browser's back/forward and the breadcrumb both step back. The final level
   * offers "Choose this style" (owner only).
   */
  let { data }: { data: PageData } = $props()

  let mode = $state<PreviewMode>('light')
  let choosing = $state(false)
  let chooseError = $state('')

  const levelTitle = $derived(
    data.needsModuleActivation
      ? ''
      : data.current === null
        ? 'Pick a direction'
        : data.current.level === 'genre'
          ? `Styles in ${data.current.name}`
          : data.current.level === 'style'
            ? `Variants of ${data.current.name}`
            : data.current.name,
  )
  const duration = $derived(prefersReducedMotion.current ? 0 : 220)

  onMount(() => {
    // Previews start in the app's own mode; the switch below flips them.
    mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  })

  async function choose(nodeId: string): Promise<void> {
    choosing = true
    chooseError = ''
    try {
      const response = await fetch('/api/brand/picker/choose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId }),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Choosing failed (${response.status}): ${text.slice(0, 400)}`)
      }
      await invalidateAll()
    } catch (err) {
      chooseError = err instanceof Error ? err.message : String(err)
    } finally {
      choosing = false
    }
  }
</script>

<svelte:head>
  <title>Brand — choose your style</title>
</svelte:head>

{#if data.needsModuleActivation}
  <ActivationNotice />
{:else}
  <div class="flex w-full flex-col gap-6 px-4 py-8 md:px-8">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div class="flex flex-col gap-2">
        <PickerBreadcrumb trail={data.trail} />
        <h1 class="text-3xl font-semibold tracking-tight">{levelTitle}</h1>
        {#if data.active}
          <p class="text-muted-foreground text-sm" data-testid="active-style">
            Active style:
            {#if data.active.nodeId}
              <a class="text-foreground font-medium underline-offset-4 hover:underline" href={resolve(`/brand${pickerQuery(data.active.nodeId)}` as '/brand')}>
                {data.active.path.join(' › ')}
              </a>
            {:else}
              <span class="text-foreground font-medium">{data.active.name}</span>
            {/if}
          </p>
        {:else}
          <p class="text-muted-foreground text-sm" data-testid="active-style">No style chosen yet — the app uses its default look.</p>
        {/if}
      </div>
      <div class="border-border bg-muted inline-flex rounded-lg border p-0.5 text-sm" role="group" aria-label="Preview mode">
        {#each ['light', 'dark'] as const as m (m)}
          <button
            type="button"
            aria-pressed={mode === m}
            class="rounded-md px-3 py-1.5 capitalize transition-colors {mode === m
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'}"
            onclick={() => (mode = m)}
          >
            {m}
          </button>
        {/each}
      </div>
    </header>

    {#key data.current?.id ?? ''}
      <div in:fly={{ y: 16, duration }}>
        {#if data.current?.level === 'variant'}
          {@const node = data.current}
          <section class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" data-testid="final-style">
            <img
              src={node.preview[mode]}
              alt={`${node.name} preview (${mode})`}
              class="border-border w-full rounded-xl border"
              width="480"
              height="300"
            />
            <div class="flex flex-col gap-4">
              <p class="text-muted-foreground">{node.description}</p>
              {#if data.active?.nodeId === node.id}
                <p class="text-foreground font-medium" data-testid="chosen-notice">This is your active style.</p>
              {:else if data.canChoose}
                <button
                  type="button"
                  class="bg-primary text-primary-foreground self-start rounded-md px-5 py-2.5 text-sm font-medium disabled:opacity-50"
                  disabled={choosing}
                  onclick={() => void choose(node.id)}
                >
                  {choosing ? 'Choosing…' : 'Choose this style'}
                </button>
              {:else}
                <p class="text-muted-foreground text-sm">Only the company owner can choose the style.</p>
              {/if}
              {#if chooseError}
                <pre class="border-destructive text-destructive rounded border p-3 text-xs whitespace-pre-wrap">{chooseError}</pre>
              {/if}
            </div>
          </section>
        {:else}
          <PickerGrid cards={data.children} {mode} />
        {/if}
      </div>
    {/key}
  </div>
{/if}
