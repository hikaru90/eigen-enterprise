<script lang="ts">
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * The Private switch on a project or note (plan/shared-memory-voice-agent-tools.md §1):
   * off (the default) = shared with everyone in the company, read-only for them;
   * on = only its owner sees it, no admin or owner override. The switch only
   * reports the person's choice (`onchange`); the caller saves it — through
   * memory.set_project_visibility / memory.set_text_file_visibility for an
   * existing item, or with the create call for a new one.
   */
  let {
    id,
    kind,
    checked,
    disabled = false,
    onchange,
  }: {
    id: string
    kind: 'project' | 'note'
    checked: boolean
    disabled?: boolean
    onchange: (isPrivate: boolean) => void
  } = $props()

  const hint = $derived(
    kind === 'project'
      ? checked
        ? m.memory_private_project_on_hint()
        : m.memory_private_project_off_hint()
      : checked
        ? m.memory_private_note_on_hint()
        : m.memory_private_note_off_hint(),
  )
</script>

<div class="flex items-start gap-3" data-testid="memory-private-switch">
  <Switch
    {id}
    {disabled}
    class="mt-0.5"
    aria-describedby="{id}-hint"
    bind:checked={() => checked, (next) => onchange(next)}
  />
  <div class="min-w-0 space-y-0.5">
    <Label for={id} class="text-sm font-medium">{m.memory_private_label()}</Label>
    <p id="{id}-hint" class="text-xs text-muted-foreground">{hint}</p>
  </div>
</div>
