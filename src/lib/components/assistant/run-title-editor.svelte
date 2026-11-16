<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { RunSummary } from '$lib/agent-runs/feed'
  import { RUN_TITLE_MAX, renameRunBody } from '$lib/agent-runs/rename'

  /**
   * Inline rename for one conversation (Contribute 495e40bb). The caller draws
   * the title (a list link, a page heading) through `display`, which gets
   * `start` to open the editor; this component owns the edit itself: Enter
   * (or leaving the field) saves, Esc cancels. Only the owner's runs are
   * `renamable`; the server checks that again.
   */
  let {
    runId,
    title,
    renamable,
    fetch: request,
    onrenamed,
    display,
    inputClass = '',
  }: {
    runId: number
    title: string
    renamable: boolean
    fetch: typeof globalThis.fetch
    onrenamed: (run: RunSummary) => void
    display: Snippet<[start: () => void]>
    inputClass?: string
  } = $props()

  let editing = $state(false)
  let draft = $state('')
  let saving = $state(false)
  let problem = $state<string | null>(null)

  function start(): void {
    if (!renamable) return
    draft = title
    problem = null
    editing = true
  }

  function cancel(): void {
    editing = false
    problem = null
  }

  async function save(): Promise<void> {
    if (!editing || saving) return
    const parsed = renameRunBody.safeParse({ title: draft })
    if (!parsed.success) {
      problem = parsed.error.issues.map((issue) => issue.message).join(' ')
      return
    }
    if (parsed.data.title === title) {
      cancel()
      return
    }
    saving = true
    problem = null
    try {
      const res = await request(`/api/agent/runs/${runId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(parsed.data),
      })
      const body = (await res.json()) as { run: RunSummary } | { error: string }
      if (!res.ok || !('run' in body)) {
        problem = 'error' in body ? body.error : `The name was not saved (HTTP ${res.status}).`
        return
      }
      editing = false
      onrenamed(body.run)
    } catch (err) {
      console.error('[assistant] rename failed', err)
      problem = 'The name was not saved.'
    } finally {
      saving = false
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
    } else if (event.key === 'Escape') {
      // Esc closes the editor, not the panel or dialog around it.
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }

  function focusAndSelect(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }
</script>

{#if editing}
  <div class="flex min-w-0 flex-1 flex-col gap-1">
    <input
      type="text"
      bind:value={draft}
      maxlength={RUN_TITLE_MAX}
      aria-label="Conversation name"
      aria-invalid={problem ? 'true' : undefined}
      disabled={saving}
      class="w-full min-w-0 rounded-md border border-input bg-background px-2 py-1 text-sm font-medium outline-none focus-visible:ring-2 -ring {inputClass}"
      data-testid="run-title-input"
      {onkeydown}
      onblur={() => void save()}
      use:focusAndSelect
    />
    {#if problem}
      <p class="text-xs text-destructive" role="alert" data-testid="run-title-problem">{problem}</p>
    {/if}
  </div>
{:else}
  {@render display(start)}
{/if}
