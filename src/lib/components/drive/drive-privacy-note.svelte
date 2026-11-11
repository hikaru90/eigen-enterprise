<script lang="ts">
  import InfoIcon from '@lucide/svelte/icons/info'
  import XIcon from '@lucide/svelte/icons/x'

  /**
   * "Who can see this?" — the Drive's real visibility rules, stated where people
   * first land (My drive). Mirrors modules/drive/service.ts + access-port.ts:
   * new items are visible to their creator plus the company owner and admins;
   * sharing adds people, groups or the whole company at view/edit/manage, and a
   * folder's grants cover what is inside it; the agent acts with admin rights.
   * There is no item hidden from the owner and admins. Dismissed per visit.
   */
  let open = $state(true)
</script>

{#if open}
  <aside
    role="note"
    aria-labelledby="drive-privacy-title"
    class="flex gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm"
  >
    <InfoIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div class="min-w-0 flex-1 space-y-1.5">
      <p id="drive-privacy-title" class="font-medium">Who can see your Drive</p>
      <ul class="list-disc space-y-1 pl-4 text-muted-foreground">
        <li>
          A folder or file you create is private until you share it: only you, the company owner and admins can
          see it.
        </li>
        <li>
          Share it with specific people, a group or the whole company, and choose whether they can view, edit or
          manage it. Sharing a folder shares everything inside it.
        </li>
        <li>The company’s agent can read and list Drive files with admin rights.</li>
        <li>There is no way to make a folder hidden from the owner and admins.</li>
      </ul>
    </div>
    <button
      type="button"
      class="size-6 shrink-0 rounded text-muted-foreground hover:text-foreground"
      aria-label="Dismiss"
      onclick={() => (open = false)}
    >
      <XIcon class="mx-auto size-4" aria-hidden="true" />
    </button>
  </aside>
{/if}
