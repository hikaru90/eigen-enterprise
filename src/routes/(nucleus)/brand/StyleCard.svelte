<script lang="ts">
  let {
    item,
    selected = false,
    distance = null,
    ontoggle = undefined,
  }: {
    item: {
      id: string
      name: string
      cssVars: Record<string, string>
      darkCssVars?: Record<string, string>
    }
    selected?: boolean
    distance?: number | null
    ontoggle?: (() => void) | undefined
  } = $props()

  // Corpus items reference OFL families that are not loaded in this app —
  // the card preview renders these fallback stacks (preview, not shipping UI).
  const FALLBACK_SANS = 'ui-sans-serif, system-ui, sans-serif'
  const FALLBACK_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

  const SWATCH_VARS = ['--primary', '--secondary', '--accent', '--muted'] as const

  const cardStyle = $derived(
    `${Object.entries(item.cssVars)
      .map(([key, value]) => `${key}: ${value}`)
      .join('; ')}; font-family: var(--font-sans, ${FALLBACK_SANS})`,
  )
  const swatches = $derived(
    SWATCH_VARS.map((name) => ({ name, value: item.cssVars[name] })).filter(
      (swatch) => typeof swatch.value === 'string',
    ),
  )
  const radiusValue = $derived(item.cssVars['--radius'] ?? '0.25rem')
</script>

<button
  type="button"
  class="style-card"
  class:selected
  style={cardStyle}
  aria-pressed={selected}
  onclick={() => ontoggle?.()}
>
  <header class="head">
    <strong class="name">{item.name}</strong>
    {#if distance !== null}
      <span class="distance" style={`font-family: var(--font-mono, ${FALLBACK_MONO})`}>
        Δ {Math.round(distance * 100)}%
      </span>
    {/if}
  </header>
  <div class="swatches">
    {#each swatches as swatch (swatch.name)}
      <span class="swatch" style:background={swatch.value} title={swatch.name}></span>
    {/each}
    <span class="radius-cue" style="border-radius: var(--radius, 0.25rem)" title={`--radius: ${radiusValue}`}></span>
  </div>
  <nav class="nav">
    <span>Product</span>
    <span>Pricing</span>
    <span>About</span>
  </nav>
  <div class="mini-card">
    <h3 class="heading">Heading specimen</h3>
    <p class="copy">Card copy with a muted supporting line.</p>
    <div class="controls">
      <span class="btn">Action</span>
      <span class="input">Input…</span>
    </div>
  </div>
</button>

<style>
  .style-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 15rem;
    padding: 0.75rem;
    text-align: left;
    background: var(--background, #fff);
    color: var(--foreground, #111);
    border: 1px solid var(--border, #ddd);
    border-radius: calc(var(--radius, 0.25rem) + 3px);
    cursor: pointer;
  }
  .style-card.selected {
    outline: 3px solid #2563eb;
    outline-offset: 2px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .name {
    font-size: 0.85rem;
    line-height: 1.2;
  }
  .distance {
    font-size: 0.7rem;
    color: var(--muted-foreground, #666);
  }
  .swatches {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .swatch {
    width: 1rem;
    height: 1rem;
    border: 1px solid rgb(0 0 0 / 0.15);
  }
  .radius-cue {
    width: 1.75rem;
    height: 1rem;
    margin-left: auto;
    border: 2px solid var(--primary, #333);
  }
  .nav {
    display: flex;
    gap: 0.75rem;
    font-size: 0.7rem;
    color: var(--primary, #333);
  }
  .mini-card {
    padding: 0.5rem;
    background: var(--card, #fff);
    color: var(--card-foreground, #111);
    border: 1px solid var(--border, #ddd);
    border-radius: var(--radius-lg, 0.25rem);
    box-shadow: var(--shadow-1, none);
  }
  .heading {
    margin: 0 0 0.25rem;
    font-family: var(--font-display, inherit);
    font-size: 1rem;
    line-height: 1.2;
    color: var(--foreground, #111);
  }
  .copy {
    margin: 0 0 0.5rem;
    font-size: 0.7rem;
    line-height: 1.4;
    color: var(--muted-foreground, #666);
  }
  .controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .btn {
    padding: 0.25rem 0.5rem;
    background: var(--primary, #333);
    color: var(--primary-foreground, #fff);
    border: none;
    border-radius: var(--radius-md, 0.2rem);
    font-size: 0.7rem;
  }
  .input {
    flex: 1;
    padding: 0.25rem 0.5rem;
    background: var(--background, #fff);
    color: var(--foreground, #111);
    border: 1px solid var(--input, #ccc);
    border-radius: var(--radius-sm, 0.15rem);
    font-size: 0.7rem;
  }
</style>
