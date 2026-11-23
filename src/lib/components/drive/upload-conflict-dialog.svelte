<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import * as Dialog from '$lib/components/ui/dialog'
  import type { ConflictDecision, UploadConflict } from '$lib/drive/upload'

  /**
   * An upload's name is already in its folder (bug f45acdef): Replace (the
   * file there gets the upload as a new revision, the old one stays in its
   * history), Keep both (the upload is added as “name (2).ext”) or Cancel
   * (this file is left out). With more files to come, the answer can be
   * applied to every later clash. Escape or closing is Cancel. Answers once.
   */
  let {
    conflict,
    onanswer,
  }: { conflict: UploadConflict; onanswer: (d: ConflictDecision) => void } = $props()

  let open = $state(true)
  let applyAll = $state(false)
  let answered = false

  function answer(choice: ConflictDecision['choice']) {
    if (answered) return
    answered = true
    open = false
    onanswer({ choice, all: conflict.more && applyAll })
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(o) => {
    if (!o) answer('skip')
  }}
>
  <Dialog.Content class="max-w-md" data-testid="drive-upload-conflict">
    <Dialog.Header>
      <Dialog.Title>This file already exists</Dialog.Title>
      <Dialog.Description>
        {conflict.message}
        {#if conflict.existing.archivedAt}It is archived.{/if}
        Replace it with the one you’re uploading — its current version stays in the file’s history — or
        keep both.
      </Dialog.Description>
    </Dialog.Header>
    {#if conflict.more}
      <label class="flex items-center gap-2 text-sm" data-testid="drive-upload-conflict-all">
        <Checkbox checked={applyAll} onCheckedChange={(v) => (applyAll = v === true)} />
        <span>Do the same for the other files that clash</span>
      </label>
    {/if}
    <Dialog.Footer>
      <Button
        variant="outline"
        onclick={() => answer('skip')}
        data-testid="drive-upload-conflict-cancel">Cancel</Button
      >
      <Button
        variant="outline"
        onclick={() => answer('keep_both')}
        data-testid="drive-upload-conflict-keep">Keep both</Button
      >
      <Button onclick={() => answer('replace')} data-testid="drive-upload-conflict-replace"
        >Replace</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
