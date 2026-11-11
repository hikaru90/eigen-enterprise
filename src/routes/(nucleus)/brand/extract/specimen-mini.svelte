<script lang="ts">
  let {
    title,
    candidate,
  }: {
    title: string
    candidate: { label: string; cssVars?: Record<string, string>; error?: string }
  } = $props()

  // Inline custom properties cascade to the specimen subtree only — no global leakage.
  const varsStyle = $derived(
    Object.entries(candidate.cssVars ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join('; '),
  )
</script>

{#if candidate.error}
  <div class="ee-specimen-invalid">
    <strong>{candidate.label}</strong>: invalid candidate — {candidate.error}
  </div>
{:else}
  <section class="specimen" style={varsStyle}>
    <header class="specimen-header">
      <h1>{title}</h1>
      <nav>
        <a href="#product" onclick={(e) => e.preventDefault()}>Product</a>
        <a href="#pricing" onclick={(e) => e.preventDefault()}>Pricing</a>
        <a href="#about" onclick={(e) => e.preventDefault()}>About</a>
      </nav>
    </header>
    <div class="cards">
      <article class="card">
        <h2>Feature card</h2>
        <p>Body copy set in the candidate's sans at step 0. Muted text below shows hierarchy.</p>
        <p class="muted">Muted supporting line.</p>
      </article>
      <article class="card">
        <h2>Second card</h2>
        <p>Radius, border and shadow tokens come straight from the expanded seeds.</p>
      </article>
    </div>
    <div class="controls">
      <button type="button" class="primary">Primary action</button>
      <input type="text" placeholder="Text input" />
    </div>
    <footer>Footer strip</footer>
  </section>
{/if}

<style>
  .specimen {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 1rem);
    padding: var(--space-3, 1rem);
    background: var(--background, #fff);
    color: var(--foreground, #111);
    font-family: var(--font-sans, sans-serif);
    border: 1px solid var(--border, #ddd);
  }
  .specimen-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2, 0.5rem);
  }
  .specimen h1 {
    margin: 0;
    font-family: var(--font-display, inherit);
    font-size: var(--text-step-3, 1.5rem);
    line-height: var(--text-step-3-lh, 1.2);
    letter-spacing: var(--text-step-3-tracking, normal);
    color: var(--foreground, #111);
  }
  .specimen nav {
    display: flex;
    gap: var(--space-2, 0.5rem);
  }
  .specimen a {
    color: var(--primary, #111);
    text-decoration: none;
    font-size: var(--text-step-0, 1rem);
  }
  .cards {
    display: flex;
    gap: var(--space-2, 0.5rem);
  }
  .specimen .card {
    flex: 1;
    margin: 0;
    padding: var(--space-3, 1rem);
    background: var(--card, #fff);
    color: var(--card-foreground, #111);
    border: 1px solid var(--border, #ddd);
    border-radius: var(--radius-lg, 0.25rem);
    box-shadow: var(--shadow-1, none);
  }
  .specimen h2 {
    margin: 0 0 var(--space-1, 0.25rem);
    font-size: var(--text-step-1, 1.1rem);
    line-height: var(--text-step-1-lh, 1.3);
  }
  .specimen p {
    margin: 0 0 var(--space-1, 0.25rem);
    font-size: var(--text-step-0, 1rem);
    line-height: var(--text-step-0-lh, 1.5);
  }
  .specimen .muted {
    color: var(--muted-foreground, #666);
  }
  .controls {
    display: flex;
    gap: var(--space-2, 0.5rem);
    align-items: center;
  }
  .specimen .primary {
    padding: var(--space-2, 0.5rem) var(--space-3, 1rem);
    background: var(--primary, #111);
    color: var(--primary-foreground, #fff);
    border: none;
    border-radius: var(--radius-md, 0.25rem);
    font-family: inherit;
    font-size: var(--text-step-0, 1rem);
    cursor: pointer;
  }
  .specimen input {
    flex: 1;
    padding: var(--space-2, 0.5rem);
    background: var(--background, #fff);
    color: var(--foreground, #111);
    border: 1px solid var(--input, #ccc);
    border-radius: var(--radius-sm, 0.2rem);
    font-family: inherit;
  }
  .specimen footer {
    padding: var(--space-2, 0.5rem);
    background: var(--secondary, #eee);
    color: var(--secondary-foreground, #111);
    border-radius: var(--radius-sm, 0.2rem);
    font-size: var(--text-step-0, 0.8rem);
  }
  .ee-specimen-invalid {
    padding: 1rem;
    border: 1px dashed #c0392b;
    color: #c0392b;
    font-size: 0.85rem;
  }
</style>
