<script lang="ts">
  import type { SpecimenSectionId } from '../style-format/drivers'

  /**
   * Full specimen canvas (phase-2d M6, V8): the in-repo demo component set —
   * nav, hero, card grid, form, pricing, footer — rendered in a sandboxed
   * scope and styled ENTIRELY by the injected cssVars (dark merge optional).
   * Flexbox + semantic elements only; no drag/layout manipulation. Clicking a
   * section reports it so the editor panel can highlight the driving tokens
   * (the token lists live in style-format/drivers.ts and match this markup).
   * Svelte scopes this component's styles per instance — no global leakage.
   */
  let {
    cssVars,
    darkCssVars = null,
    dark = false,
    brandName = 'Kindred Digital Labs',
    onsectionclick = undefined,
  }: {
    cssVars: Record<string, string>
    darkCssVars?: Record<string, string> | null
    dark?: boolean
    brandName?: string
    onsectionclick?: ((section: SpecimenSectionId) => void) | undefined
  } = $props()

  const effectiveVars = $derived(dark && darkCssVars ? { ...cssVars, ...darkCssVars } : cssVars)
  const varsStyle = $derived(
    Object.entries(effectiveVars)
      .map(([key, value]) => `${key}: ${value}`)
      .join('; '),
  )

  const uid = $props.id()

  function keyActivate(section: SpecimenSectionId): (event: KeyboardEvent) => void {
    return (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onsectionclick?.(section)
      }
    }
  }
</script>

<div class="specimen" style={varsStyle}>
  <!--
    Each section is a click-to-highlight affordance (V8): the owner clicks it
    to reveal the driving tokens. The sections keep their semantic roles —
    the a11y ignores below mirror the repo idiom (src/routes/chat/+page.svelte)
    for exactly this interactive-surface-on-semantic-element case; keyboard
    access is provided via tabindex + Enter/Space.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <header
    class="section nav"
    role="group"
    aria-label="Specimen: top navigation"
    data-section="nav"
    tabindex="0"
    onclick={() => onsectionclick?.('nav')}
    onkeydown={keyActivate('nav')}
  >
    <span class="nav-brand">{brandName}</span>
    <nav class="nav-links" aria-label="Specimen links">
      <a href="#product" onclick={(e) => e.preventDefault()}>Product</a>
      <a href="#pricing" onclick={(e) => e.preventDefault()}>Pricing</a>
      <a href="#about" onclick={(e) => e.preventDefault()}>About</a>
    </nav>
    <button type="button" class="nav-cta">Get started</button>
  </header>

  <main>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <section
      class="section hero"
      role="group"
      aria-label="Specimen: hero"
      data-section="hero"
      tabindex="0"
      onclick={() => onsectionclick?.('hero')}
      onkeydown={keyActivate('hero')}
    >
      <h1>Design once. Apply everywhere.</h1>
      <p class="hero-sub">
        Every surface below is styled by your draft's tokens — colors, type, radius, spacing,
        shadows.
      </p>
      <div class="hero-actions">
        <button type="button" class="hero-primary">Primary action</button>
        <button type="button" class="hero-secondary">Secondary</button>
      </div>
    </section>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <section
      class="section cards"
      role="group"
      aria-label="Specimen: card grid"
      data-section="cards"
      tabindex="0"
      onclick={() => onsectionclick?.('cards')}
      onkeydown={keyActivate('cards')}
    >
      <article class="card">
        <span class="card-dot" aria-hidden="true"></span>
        <h2>Fast setup</h2>
        <p>Body copy set in the specimen sans with a muted supporting line below.</p>
        <a class="card-link" href="#more" onclick={(e) => e.preventDefault()}>Learn more</a>
      </article>
      <article class="card">
        <span class="card-dot" aria-hidden="true"></span>
        <h2>Own your data</h2>
        <p>Cards pick up surface, border, radius and shadow tokens from the draft.</p>
        <a class="card-link" href="#more" onclick={(e) => e.preventDefault()}>Learn more</a>
      </article>
      <article class="card">
        <span class="card-dot" aria-hidden="true"></span>
        <h2>Composable</h2>
        <p>Muted text shows the hierarchy between foreground and supporting copy.</p>
        <a class="card-link" href="#more" onclick={(e) => e.preventDefault()}>Learn more</a>
      </article>
    </section>

    <div class="lower">
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <section
        class="section form"
        role="group"
        aria-label="Specimen: form"
        data-section="form"
        tabindex="0"
        onclick={() => onsectionclick?.('form')}
        onkeydown={keyActivate('form')}
      >
        <form onsubmit={(e) => e.preventDefault()}>
          <label class="form-label" for={`${uid}-name`}>
            Name
            <span class="form-required">required</span>
          </label>
          <input id={`${uid}-name`} type="text" placeholder="Text input" />
          <label class="form-label" for={`${uid}-topic`}>Topic</label>
          <select id={`${uid}-topic`}>
            <option>Design systems</option>
            <option>Brand tokens</option>
          </select>
          <label class="form-label" for={`${uid}-notes`}>Notes</label>
          <textarea id={`${uid}-notes`} rows="3" placeholder="Textarea"></textarea>
          <button type="submit" class="form-submit">Submit</button>
          <p class="form-hint">We reply within two working days.</p>
        </form>
      </section>

      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <section
        class="section pricing"
        role="group"
        aria-label="Specimen: pricing"
        data-section="pricing"
        tabindex="0"
        onclick={() => onsectionclick?.('pricing')}
        onkeydown={keyActivate('pricing')}
      >
        <article class="pricing-card">
          <span class="pricing-badge">Most popular</span>
          <p class="pricing-price">$29 <span class="pricing-per">/ month</span></p>
          <ul>
            <li>Unlimited drafts</li>
            <li>Approval-gated publish</li>
            <li>Audit trail</li>
          </ul>
          <button type="button" class="pricing-cta">Choose plan</button>
        </article>
      </section>
    </div>
  </main>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <footer
    class="section footer"
    role="group"
    aria-label="Specimen: footer"
    data-section="footer"
    tabindex="0"
    onclick={() => onsectionclick?.('footer')}
    onkeydown={keyActivate('footer')}
  >
    <div class="footer-cols">
      <span>Product</span>
      <span>Company</span>
      <span>Legal</span>
    </div>
    <p class="footer-legal">© 2026 — specimen footer strip</p>
  </footer>
</div>

<style>
  .specimen {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    background: var(--background, #fff);
    color: var(--foreground, #111);
    font-family: var(--font-sans, sans-serif);
  }

  .section {
    cursor: pointer;
  }

  /* -- nav ---------------------------------------------------------------- */
  .nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 1rem);
    padding: var(--space-2, 0.5rem) var(--space-3, 1rem);
    border-bottom: 1px solid var(--border, #ddd);
  }
  .nav-brand {
    font-size: var(--text-step-1, 1.1rem);
    font-weight: 600;
  }
  .nav-links {
    display: flex;
    gap: var(--space-3, 1rem);
  }
  .nav a {
    color: var(--primary, #111);
    text-decoration: none;
    font-size: var(--text-step-0, 1rem);
  }
  .nav-cta {
    padding: var(--space-2, 0.5rem) var(--space-3, 1rem);
    background: var(--primary, #111);
    color: var(--primary-foreground, #fff);
    border: none;
    border-radius: var(--radius-md, 0.25rem);
    font-family: inherit;
    font-size: var(--text-step-0, 1rem);
    cursor: pointer;
    transition: background var(--duration-fast, 150ms) var(--ease-enter, ease);
  }

  /* -- hero --------------------------------------------------------------- */
  .hero {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 1rem);
    padding: var(--space-3, 1rem);
  }
  .hero h1 {
    margin: 0;
    font-family: var(--font-display, inherit);
    font-size: var(--text-step-3, 1.5rem);
    line-height: var(--text-step-3-lh, 1.2);
    letter-spacing: var(--text-step-3-tracking, normal);
  }
  .hero-sub {
    margin: 0;
    max-width: 60ch;
    font-size: var(--text-step-1, 1.1rem);
  }
  .hero-actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
  }
  .hero-primary,
  .hero-secondary {
    padding: var(--space-2, 0.5rem) var(--space-3, 1rem);
    border: none;
    border-radius: var(--radius-md, 0.25rem);
    font-family: inherit;
    font-size: var(--text-step-0, 1rem);
    cursor: pointer;
  }
  .hero-primary {
    background: var(--primary, #111);
    color: var(--primary-foreground, #fff);
  }
  .hero-secondary {
    background: var(--secondary, #eee);
    color: var(--secondary-foreground, #111);
  }

  /* -- cards -------------------------------------------------------------- */
  .cards {
    display: flex;
    gap: var(--space-3, 1rem);
    padding: var(--space-3, 1rem);
    background: var(--background, #fff);
    font-family: var(--font-sans, sans-serif);
  }
  .card {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    margin: 0;
    padding: var(--space-3, 1rem);
    background: var(--card, #fff);
    color: var(--card-foreground, #111);
    border: 1px solid var(--border, #ddd);
    border-radius: var(--radius-lg, 0.5rem);
    box-shadow: var(--shadow-1, none);
  }
  .card-dot {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: var(--accent, #eee);
  }
  .card h2 {
    margin: 0;
    font-size: var(--text-step-1, 1.1rem);
  }
  .card p {
    margin: 0;
    font-size: var(--text-step-0, 1rem);
    line-height: var(--text-step-0-lh, 1.5);
    color: var(--muted-foreground, #666);
  }
  .card-link {
    color: var(--card-foreground, #111);
    font-size: var(--text-step-0, 1rem);
  }

  /* -- form + pricing row ------------------------------------------------- */
  .lower {
    display: flex;
    align-items: stretch;
    gap: var(--space-3, 1rem);
    padding: var(--space-3, 1rem);
  }
  .form {
    flex: 1;
    padding: var(--space-3, 1rem);
    background: var(--card, #fff);
    color: var(--card-foreground, #111);
    border: 1px solid var(--border, #ddd);
    border-radius: var(--radius-md, 0.25rem);
  }
  .form form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    font-family: var(--font-sans, sans-serif);
  }
  .form-label {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    font-size: var(--text-step-0, 1rem);
    color: var(--foreground, #111);
  }
  .form-required {
    padding: 0 var(--space-2, 0.5rem);
    background: var(--accent, #eee);
    color: var(--accent-foreground, #111);
    border-radius: var(--radius-sm, 0.25rem);
    font-size: var(--text-step-0, 1rem);
  }
  .form input,
  .form select,
  .form textarea {
    padding: var(--space-2, 0.5rem);
    background: var(--card, #fff);
    color: var(--card-foreground, #111);
    border: 1px solid var(--input, #ccc);
    border-radius: var(--radius-sm, 0.25rem);
    font-family: inherit;
    font-size: var(--text-step-0, 1rem);
  }
  .form select {
    background: var(--popover, #fff);
    color: var(--popover-foreground, #111);
  }
  .form input:focus-visible,
  .form select:focus-visible,
  .form textarea:focus-visible {
    outline: 2px solid var(--ring, #999);
  }
  .form-submit {
    align-self: flex-start;
    padding: var(--space-2, 0.5rem) var(--space-3, 1rem);
    background: var(--primary, #111);
    color: var(--primary-foreground, #fff);
    border: none;
    border-radius: var(--radius-md, 0.25rem);
    font-family: inherit;
    font-size: var(--text-step-0, 1rem);
    cursor: pointer;
    transition: background var(--duration-fast, 150ms) var(--ease-enter, ease);
  }
  .form-hint {
    margin: 0;
    font-size: var(--text-step-0, 1rem);
    color: var(--muted-foreground, #666);
  }

  /* -- pricing ------------------------------------------------------------ */
  .pricing {
    flex: 1;
    padding: var(--space-3, 1rem);
    font-family: var(--font-sans, sans-serif);
  }
  .pricing-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    margin: 0;
    padding: var(--space-3, 1rem);
    background: var(--card, #fff);
    color: var(--card-foreground, #111);
    border: 1px solid var(--border, #ddd);
    border-radius: var(--radius-xl, 0.75rem);
    box-shadow: var(--shadow-2, none);
  }
  .pricing-badge {
    align-self: flex-start;
    padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
    background: var(--muted, #eee);
    color: var(--muted-foreground, #666);
    border-radius: var(--radius, 0.25rem);
    font-size: var(--text-step-0, 1rem);
  }
  .pricing-price {
    margin: 0;
    font-family: var(--font-display, inherit);
    font-size: var(--text-step-2, 1.25rem);
  }
  .pricing-per {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-step-0, 1rem);
  }
  .pricing ul {
    margin: 0;
    padding-left: var(--space-3, 1rem);
    color: var(--muted-foreground, #666);
    font-size: var(--text-step-0, 1rem);
  }
  .pricing li {
    margin: var(--space-1, 0.25rem) 0;
  }
  .pricing-cta {
    align-self: flex-start;
    padding: var(--space-2, 0.5rem) var(--space-3, 1rem);
    background: var(--primary, #111);
    color: var(--primary-foreground, #fff);
    border: none;
    border-radius: var(--radius-md, 0.25rem);
    font-family: inherit;
    font-size: var(--text-step-0, 1rem);
    cursor: pointer;
    transition: background var(--duration-fast, 150ms) var(--ease-enter, ease);
  }

  /* -- footer ------------------------------------------------------------- */
  .footer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    margin-top: auto;
    padding: var(--space-3, 1rem);
    background: var(--secondary, #eee);
    color: var(--secondary-foreground, #111);
    border-top: 1px solid var(--border, #ddd);
    font-family: var(--font-sans, sans-serif);
  }
  .footer-cols {
    display: flex;
    gap: var(--space-3, 1rem);
    font-size: var(--text-step-0, 1rem);
  }
  .footer-legal {
    margin: 0;
    font-size: var(--text-step-0, 1rem);
    color: var(--muted-foreground, #666);
  }
</style>
