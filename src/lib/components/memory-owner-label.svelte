<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Whose a colleague's shared project or note is, and that it is read-only for
   * the reader (plan/shared-memory-voice-agent-tools.md §1). Shown only on
   * other people's items; the reader's own carry no label.
   */
  let { name }: { name: string } = $props()
</script>

<span
  class="inline-flex max-w-full items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs leading-none text-muted-foreground"
  title={m.memory_read_only_hint({ name })}
  data-testid="memory-owner-label"
>
  <span class="truncate">{m.memory_owner_by({ name })}</span>
  <span aria-hidden="true">·</span>
  <span>{m.memory_read_only()}</span>
</span>
