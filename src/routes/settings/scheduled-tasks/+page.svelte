<script lang="ts">
  import { resolve } from '$app/paths'

  /**
   * Placeholder: the eigen heartbeat UI is gone. The server-side scheduled
   * task APIs (load below, /api endpoints) remain available untouched.
   */
</script>

<svelte:head>
  <title>Heartbeat · Eigen Enterprise</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl px-4 py-10">
  <p class="text-muted-foreground text-[11px] font-medium tracking-[0.25em] uppercase">
    Eigen Enterprise
  </p>
  <h1 class="mt-1 text-xl font-medium tracking-tight">Heartbeat</h1>
  <p class="text-muted-foreground mt-3 text-sm leading-relaxed">
    This surface is not part of Eigen Enterprise yet. The underlying APIs remain available.
  </p>
  <a
    href={resolve('/settings')}
    class="border-black/15 hover:border-black mt-6 inline-block border px-3 py-2 text-xs font-medium"
  >
    ← Back to settings
  </a>
</div>
