<script lang="ts">
  import type { ArtifactPanel } from './artifact-panel-state.svelte'
  import FileDown from '@lucide/svelte/icons/file-down'
  import X from '@lucide/svelte/icons/x'
  import { resolve } from '$app/paths'

  /**
   * The artifact beside the chat: the page or deck rendered in a sandboxed
   * frame (scripts only — no same origin, so no session or cookies), Open in
   * Drive, Export PDF. On phones it covers the screen above the chat.
   */
  let { panel }: { panel: ArtifactPanel } = $props()
</script>

{#if panel.open}
  <section
    aria-label="Artifact"
    data-testid="artifact-panel"
    class="fixed inset-0 z-[60] flex min-h-0 flex-col bg-background md:relative md:inset-auto md:z-auto md:min-w-[22rem] md:flex-1 md:border-l md:border-border"
  >
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-[env(safe-area-inset-top)]">
      <div class="min-w-0 flex-1">
        <p class="truncate text-[13px] font-medium" data-testid="artifact-name">{panel.view?.name ?? 'Opening…'}</p>
        {#if panel.view?.kind === 'deck'}
          <p class="text-[11px] text-foreground/55">{panel.view.slideCount} {panel.view.slideCount === 1 ? 'slide' : 'slides'}</p>
        {/if}
      </div>
      {#if panel.view}
        <a
          href={resolve('/(nucleus)/drive/file/[id]', { id: panel.view.fileId })}
          class="rounded-md px-2 py-1 text-[13px] text-foreground/70 hover:bg-primary/[0.06] hover:text-foreground"
          data-testid="artifact-open-drive">Open in Drive</a
        >
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-foreground/70 hover:bg-primary/[0.06] hover:text-foreground disabled:opacity-50"
          disabled={panel.exported.status === 'exporting'}
          onclick={() => panel.exportPdf()}
          data-testid="artifact-export-pdf"
        >
          <FileDown class="size-4" aria-hidden="true" strokeWidth={1.75} />
          {panel.exported.status === 'exporting' ? 'Exporting…' : 'Export PDF'}
        </button>
      {/if}
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-md text-foreground/60 hover:bg-primary/[0.06] hover:text-foreground"
        aria-label="Close the artifact"
        onclick={() => panel.close()}
        data-testid="artifact-close"
      >
        <X class="size-4" aria-hidden="true" strokeWidth={1.75} />
      </button>
    </header>
    {#if panel.exported.status === 'done'}
      <p class="border-b border-border px-3 py-1.5 text-[12px]" data-testid="artifact-exported">
        Saved <a class="underline" href={resolve('/(nucleus)/drive/file/[id]', { id: panel.exported.fileId })}>{panel.exported.name}</a> in Drive.
      </p>
    {:else if panel.exported.status === 'failed'}
      <p class="border-b border-border px-3 py-1.5 text-[12px] text-destructive" role="alert">{panel.exported.message}</p>
    {/if}
    <div class="relative min-h-0 flex-1 bg-muted/30">
      {#if panel.status === 'failed'}
        <p class="p-4 text-[13px] text-destructive" role="alert" data-testid="artifact-error">{panel.error}</p>
      {:else if panel.view}
        {#key panel.view.viewUrl}
          <iframe
            title={panel.view.name}
            src={panel.view.viewUrl}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            class="size-full border-0 bg-white"
            data-testid="artifact-frame"
          ></iframe>
        {/key}
      {/if}
      {#if panel.status === 'loading'}
        <p class="absolute right-3 top-2 text-[11px] text-foreground/55" aria-live="polite">Updating…</p>
      {/if}
    </div>
  </section>
{/if}
