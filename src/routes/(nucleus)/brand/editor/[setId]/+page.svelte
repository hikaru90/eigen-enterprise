<script lang="ts">
  import type { BrandSeeds } from '../../../../../../modules/brand/style-format/seeds'
  import type { PageData } from './$types'
  import { converter, formatHex, parse } from 'culori'
  import { resolve } from '$app/paths'
  import Specimen from '../../../../../../modules/brand/specimen/Specimen.svelte'
  import {
    SECTION_DRIVERS,
    type SpecimenSectionId,
  } from '../../../../../../modules/brand/style-format/drivers'

  /**
   * Visual editor (phase-2d M6, V8): draft specimen canvas + token panel.
   * Every write goes through brand.visual_set_update (human-only, draft-only):
   * seed edits re-expand deterministically, resolved-value edits pin. No
   * drag/layout manipulation, no LLM. Highlight logic is pure $derived +
   * handlers over style-format/drivers.ts.
   */

  type VisualSet = {
    id: string
    status: string
    name: string
    seeds: BrandSeeds | null
    cssVars: Record<string, string>
    darkCssVars: Record<string, string> | null
    pins: Record<string, string>
  }

  let { data }: { data: PageData } = $props()

  let set = $state<VisualSet>(structuredClone(data.set) as unknown as VisualSet)
  let seedForm = $state<BrandSeeds | null>(set.seeds ? structuredClone(set.seeds) : null)
  let dark = $state(false)
  let selectedSection = $state<SpecimenSectionId | null>(null)
  let busy = $state(false)
  let error = $state('')

  // Core resolved roles edited directly (each write pins the value, V3).
  const RESOLVED_COLOR_ROLES = [
    'background',
    'foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'muted',
    'accent',
    'border',
    'ring',
    'card',
  ] as const

  const RESOLVED_FONTS = [
    { token: '--font-sans', label: 'Sans' },
    { token: '--font-display', label: 'Display' },
    { token: '--font-mono', label: 'Mono' },
  ] as const

  const CONTROLLED = new Set<string>([
    ...RESOLVED_COLOR_ROLES.map((role) => `--${role}`),
    '--radius',
    ...RESOLVED_FONTS.map((font) => font.token),
  ])

  const toOklch = converter('oklch')

  function round(n: number, digits: number): number {
    const f = 10 ** digits
    return Math.round(n * f) / f
  }

  function colorComponents(value: string): { l: number; c: number; h: number } | null {
    const parsed = parse(value.trim())
    if (!parsed) return null
    const color = toOklch(parsed)
    if (!color) return null
    // Achromatic colors omit c/h — 0 is the mathematically correct component.
    return { l: round(color.l ?? 0, 4), c: round(color.c ?? 0, 4), h: round(color.h ?? 0, 2) }
  }

  function hexOf(value: string): string {
    const color = parse(value.trim())
    return color ? formatHex(color) : '#808080'
  }

  function oklchStringOf(hex: string): string {
    const components = colorComponents(hex)
    if (!components) throw new Error(`unparseable color: ${hex}`)
    return `oklch(${components.l} ${components.c} ${components.h})`
  }

  function seedHexOf(components: BrandSeeds['seedColor']): string {
    return formatHex({ mode: 'oklch', l: components.l, c: components.c, h: components.h })
  }

  function isPinned(token: string): boolean {
    return set.pins[token] !== undefined
  }

  function isHighlighted(token: string): boolean {
    return selectedSection !== null && SECTION_DRIVERS[selectedSection].includes(token)
  }

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status}): ${text.slice(0, 400)}`)
    }
    return JSON.parse(text) as Record<string, unknown>
  }

  async function send(body: Record<string, unknown>): Promise<void> {
    busy = true
    error = ''
    try {
      const result = (await post(`/api/brand/visual-sets/${set.id}/update`, body)) as VisualSet
      set = result
      if (set.seeds) seedForm = structuredClone(set.seeds)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function applyResolved(token: string, value: string): void {
    void send({ cssVarsPatch: { [token]: value } })
  }

  function clearPin(token: string): void {
    void send({ clearPins: [token] })
  }

  function applySeeds(): void {
    if (!seedForm) return
    void send({ seedsPatch: seedForm })
  }

  function selectSection(section: SpecimenSectionId): void {
    selectedSection = section
    const first = SECTION_DRIVERS[section].find((token) => CONTROLLED.has(token))
    if (first) document.getElementById(`ctl${first}`)?.scrollIntoView({ block: 'center' })
  }

  function scrollToControl(token: string): void {
    document.getElementById(`ctl${token}`)?.scrollIntoView({ block: 'center' })
  }
</script>

<svelte:head>
  <title>Visual editor — {set.name}</title>
</svelte:head>

<div class="flex min-h-dvh flex-col bg-neutral-50 text-neutral-900">
  <header class="flex flex-wrap items-center gap-3 border-b bg-white px-4 py-2">
    <a class="text-sm underline" href={resolve('/brand')}>← Brand</a>
    <label class="flex items-center gap-2 text-sm">
      <span class="text-neutral-500">Draft</span>
      <input
        type="text"
        class="rounded border px-2 py-1 text-sm"
        value={set.name}
        onchange={(e) => {
          const name = e.currentTarget.value.trim()
          if (name.length > 0 && name !== set.name) void send({ name })
        }}
      />
    </label>
    <span class="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium uppercase">{set.status}</span>
    <button
      type="button"
      class="ml-auto rounded border px-3 py-1 text-sm hover:bg-neutral-100"
      aria-pressed={dark}
      onclick={() => (dark = !dark)}
    >
      {dark ? 'Dark' : 'Light'} preview
    </button>
  </header>

  {#if error}
    <pre class="whitespace-pre-wrap rounded border border-red-400 bg-red-50 p-3 text-xs text-red-800">{error}</pre>
  {/if}

  <div class="flex min-h-0 flex-1">
    <div class="min-w-0 flex-1 p-4">
      <Specimen
        cssVars={set.cssVars}
        darkCssVars={set.darkCssVars}
        {dark}
        brandName={set.name}
        onsectionclick={selectSection}
      />
    </div>

    <aside class="flex w-96 shrink-0 flex-col gap-6 overflow-y-auto border-l bg-white p-4">
      {#if selectedSection}
        <div class="flex flex-col gap-2 rounded border border-amber-400 bg-amber-50 p-3">
          <h2 class="text-sm font-semibold">“{selectedSection}” is driven by</h2>
          <ul class="flex flex-wrap gap-1">
            {#each SECTION_DRIVERS[selectedSection] as token (token)}
              <li>
                {#if CONTROLLED.has(token)}
                  <button
                    type="button"
                    class="rounded bg-white px-1.5 py-0.5 font-mono text-xs underline hover:bg-neutral-100"
                    onclick={() => scrollToControl(token)}
                  >
                    {token}
                  </button>
                {:else}
                  <span class="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-500">{token}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <section class="flex flex-col gap-3">
        <h2 class="text-lg font-medium">Seeds</h2>
        {#if seedForm}
          <p class="text-xs text-neutral-500">
            Applying seeds re-expands every token deterministically. Pinned resolved values
            (marked ●) survive re-expansion.
          </p>

          <div class="flex flex-col gap-2">
            <span class="text-sm font-medium">Seed color</span>
            <div class="flex items-center gap-2">
              <input
                type="color"
                class="h-8 w-10 cursor-pointer"
                value={seedHexOf(seedForm.seedColor)}
                onchange={(e) => {
                  const components = colorComponents(e.currentTarget.value)
                  if (components && seedForm) {
                    seedForm.seedColor = components
                    applySeeds()
                  }
                }}
              />
              <label class="flex items-center gap-1 text-xs">L
                <input type="number" class="w-20 rounded border px-1 py-0.5" min="0" max="1" step="0.01" bind:value={seedForm.seedColor.l} />
              </label>
              <label class="flex items-center gap-1 text-xs">C
                <input type="number" class="w-20 rounded border px-1 py-0.5" min="0" max="0.4" step="0.005" bind:value={seedForm.seedColor.c} />
              </label>
              <label class="flex items-center gap-1 text-xs">H
                <input type="number" class="w-20 rounded border px-1 py-0.5" min="0" max="360" step="1" bind:value={seedForm.seedColor.h} />
              </label>
            </div>

            <label class="flex items-center justify-between gap-2 text-sm">Neutral tint hue
              <input type="number" class="w-24 rounded border px-1 py-0.5" min="0" max="360" step="1" bind:value={seedForm.neutralTintHue} />
            </label>

            <label class="flex items-center justify-between gap-2 text-sm">Radius base
              <input type="text" class="w-24 rounded border px-1 py-0.5" bind:value={seedForm.radiusBase} />
            </label>

            <span class="text-sm font-medium">Base size (px)</span>
            <div class="flex items-center gap-2 text-xs">
              <label class="flex items-center gap-1">min
                <input type="number" class="w-20 rounded border px-1 py-0.5" min="1" step="1" bind:value={seedForm.fluidScale.baseSize.min} />
              </label>
              <label class="flex items-center gap-1">max
                <input type="number" class="w-20 rounded border px-1 py-0.5" min="1" step="1" bind:value={seedForm.fluidScale.baseSize.max} />
              </label>
            </div>

            <span class="text-sm font-medium">Scale ratio</span>
            <div class="flex items-center gap-2 text-xs">
              <label class="flex items-center gap-1">min
                <input type="number" class="w-24 rounded border px-1 py-0.5" min="1.01" step="0.001" bind:value={seedForm.fluidScale.scaleRatio.min} />
              </label>
              <label class="flex items-center gap-1">max
                <input type="number" class="w-24 rounded border px-1 py-0.5" min="1.01" step="0.001" bind:value={seedForm.fluidScale.scaleRatio.max} />
              </label>
            </div>

            <span class="text-sm font-medium">Fonts (OFL families)</span>
            <label class="flex items-center justify-between gap-2 text-xs">Primary
              <input type="text" class="w-48 rounded border px-1 py-0.5" bind:value={seedForm.fonts.fontPrimary} />
            </label>
            <label class="flex items-center justify-between gap-2 text-xs">Secondary
              <input type="text" class="w-48 rounded border px-1 py-0.5" bind:value={seedForm.fonts.fontSecondary} />
            </label>
            <label class="flex items-center justify-between gap-2 text-xs">Mono
              <input type="text" class="w-48 rounded border px-1 py-0.5" bind:value={seedForm.fonts.fontMono} />
            </label>

            <label class="flex items-center justify-between gap-2 text-sm">Chroma curve
              <select
                class="w-32 rounded border px-1 py-0.5"
                value={seedForm.chromaCurve}
                onchange={(e) => (seedForm!.chromaCurve = e.currentTarget.value as BrandSeeds['chromaCurve'])}
              >
                <option value="tailwind">tailwind</option>
                <option value="flat">flat</option>
                <option value="muted">muted</option>
              </select>
            </label>

            <label class="flex items-center justify-between gap-2 text-sm">Shape character
              <select
                class="w-32 rounded border px-1 py-0.5"
                value={seedForm.shapeCharacter}
                onchange={(e) => (seedForm!.shapeCharacter = e.currentTarget.value as BrandSeeds['shapeCharacter'])}
              >
                <option value="sharp">sharp</option>
                <option value="soft">soft</option>
                <option value="pill">pill</option>
                <option value="squircle">squircle</option>
              </select>
            </label>

            <label class="flex items-center justify-between gap-2 text-sm">Elevation
              <select
                class="w-32 rounded border px-1 py-0.5"
                value={seedForm.elevation}
                onchange={(e) => (seedForm!.elevation = e.currentTarget.value as BrandSeeds['elevation'])}
              >
                <option value="flat">flat</option>
                <option value="subtle">subtle</option>
                <option value="layered">layered</option>
              </select>
            </label>

            <label class="flex items-center justify-between gap-2 text-sm">Motion personality
              <select
                class="w-32 rounded border px-1 py-0.5"
                value={seedForm.motionPersonality}
                onchange={(e) => (seedForm!.motionPersonality = e.currentTarget.value as BrandSeeds['motionPersonality'])}
              >
                <option value="productive">productive</option>
                <option value="expressive">expressive</option>
              </select>
            </label>

            <label class="flex items-center justify-between gap-2 text-sm">Grain
              <span class="flex items-center gap-2">
                <input type="range" min="0" max="1" step="0.01" bind:value={seedForm.grain} />
                <span class="w-10 text-right font-mono text-xs">{seedForm.grain}</span>
              </span>
            </label>

            <button
              type="button"
              class="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
              disabled={busy}
              onclick={applySeeds}
            >
              {busy ? 'Working…' : 'Apply seeds'}
            </button>
          </div>
        {:else}
          <p class="text-sm text-neutral-500">
            This draft has no seed block — edit resolved values below (each edit pins the value).
          </p>
        {/if}
      </section>

      <section class="flex flex-col gap-2">
        <h2 class="text-lg font-medium">Resolved values</h2>
        <p class="text-xs text-neutral-500">
          Direct edits pin the value (●) so later seed re-expansions keep it. “clear” re-flows the
          value from the expansion.
        </p>
        {#each RESOLVED_COLOR_ROLES as role (role)}
          {@const token = `--${role}`}
          {@const value = set.cssVars[token] ?? ''}
          <div
            id={`ctl${token}`}
            class="flex items-center gap-2 rounded p-1"
            class:bg-amber-100={isHighlighted(token)}
          >
            <span class="h-5 w-5 shrink-0 rounded-full border border-neutral-300" style:background={value}></span>
            <code class="w-40 shrink-0 text-xs">{token}</code>
            {#if colorComponents(value)}
              <input
                type="color"
                class="h-7 w-9 shrink-0 cursor-pointer"
                value={hexOf(value)}
                onchange={(e) => applyResolved(token, oklchStringOf(e.currentTarget.value))}
              />
            {/if}
            <input
              type="text"
              class="w-full rounded border px-2 py-1 text-xs"
              value={value}
              onchange={(e) => applyResolved(token, e.currentTarget.value.trim())}
            />
            {#if isPinned(token)}
              <span class="shrink-0 text-amber-600" title="pinned">●</span>
              <button
                type="button"
                class="shrink-0 text-xs underline disabled:opacity-50"
                disabled={busy}
                onclick={() => clearPin(token)}
              >
                clear
              </button>
            {/if}
          </div>
        {/each}

        <div
          id="ctl--radius"
          class="mt-2 flex items-center gap-2 rounded p-1"
          class:bg-amber-100={isHighlighted('--radius')}
        >
          <code class="w-40 shrink-0 text-xs">--radius</code>
          <input
            type="text"
            class="w-full rounded border px-2 py-1 text-xs"
            value={set.cssVars['--radius'] ?? ''}
            onchange={(e) => applyResolved('--radius', e.currentTarget.value.trim())}
          />
          {#if isPinned('--radius')}
            <span class="shrink-0 text-amber-600" title="pinned">●</span>
            <button
              type="button"
              class="shrink-0 text-xs underline disabled:opacity-50"
              disabled={busy}
              onclick={() => clearPin('--radius')}
            >
              clear
            </button>
          {/if}
        </div>

        {#each RESOLVED_FONTS as font (font.token)}
          <div
            id={`ctl${font.token}`}
            class="flex items-center gap-2 rounded p-1"
            class:bg-amber-100={isHighlighted(font.token)}
          >
            <code class="w-40 shrink-0 text-xs">{font.token}</code>
            <span class="w-16 shrink-0 text-xs text-neutral-500">{font.label}</span>
            <input
              type="text"
              class="w-full rounded border px-2 py-1 text-xs"
              value={set.cssVars[font.token] ?? ''}
              onchange={(e) => applyResolved(font.token, e.currentTarget.value.trim())}
            />
            {#if isPinned(font.token)}
              <span class="shrink-0 text-amber-600" title="pinned">●</span>
              <button
                type="button"
                class="shrink-0 text-xs underline disabled:opacity-50"
                disabled={busy}
                onclick={() => clearPin(font.token)}
              >
                clear
              </button>
            {/if}
          </div>
        {/each}
      </section>
    </aside>
  </div>
</div>
