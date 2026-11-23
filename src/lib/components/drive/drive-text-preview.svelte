<script lang="ts">
  import { onMount } from 'svelte'
  import { driveApi } from '$lib/drive/api'
  import { parseCsv, type Grid } from '$lib/drive/csv-grid'

  /**
   * A grid card's glance at a text file: the opening lines (documents, plain
   * text) or the first rows (CSV). Loads once the card scrolls into view.
   * A file that can't be read shows `fallback` (the kind icon) — the card
   * stays usable; opening the file shows the real error.
   */
  let {
    fileId,
    mode,
    fallback,
  }: { fileId: string; mode: 'text' | 'table'; fallback: import('svelte').Snippet } = $props()

  const MAX_CHARS = 400
  const MAX_ROWS = 5
  const MAX_COLS = 3

  let el: HTMLDivElement
  let status = $state<'idle' | 'ready' | 'failed'>('idle')
  let text = $state('')
  let rows = $state<Grid>([])

  async function load() {
    try {
      const { content } = await driveApi.readText(fileId)
      if (mode === 'table') {
        // A long file: parse only its first whole lines.
        const head = content.length > 8_000 ? content.slice(0, content.lastIndexOf('\n', 8_000) + 1) : content
        rows = parseCsv(head)
          .slice(0, MAX_ROWS)
          .map((r) => r.slice(0, MAX_COLS))
      } else {
        text = content.slice(0, MAX_CHARS)
      }
      status = 'ready'
    } catch {
      status = 'failed'
    }
  }

  onMount(() => {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect()
        void load()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  })
</script>

<div bind:this={el} class="size-full" data-testid="drive-text-preview" data-state={status}>
  {#if status === 'ready' && mode === 'text' && text.trim() !== ''}
    <pre
      class="size-full overflow-hidden bg-background px-2.5 py-2 text-left font-mono text-[13px] leading-snug whitespace-pre-wrap break-words text-foreground/70 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">{text}</pre>
  {:else if status === 'ready' && mode === 'table' && rows.length > 0}
    <div
      class="size-full overflow-hidden bg-background p-1.5 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
    >
      <table class="w-full table-fixed border-collapse text-left text-[13px] leading-tight text-foreground/70">
        <tbody>
          {#each rows as row, r (r)}
            <tr class={r === 0 ? 'font-semibold text-foreground/80' : ''}>
              {#each row as cell, c (c)}
                <td class="truncate border border-border/60 px-1 py-0.5">{cell}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="flex size-full items-center justify-center">{@render fallback()}</div>
  {/if}
</div>
