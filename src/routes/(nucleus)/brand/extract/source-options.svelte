<script lang="ts">
  import { GUIDE_ACCEPT, GUIDE_LIMITS_TEXT } from '../../../../../modules/brand/extract/guide'

  /**
   * Where an extraction starts: capture the company's website, or upload the
   * brand guide it already has. Each option shows its own failure in plain
   * words — a server without a browser says so next to the URL field, and the
   * upload sits right beside it.
   */
  let {
    busy,
    captureError,
    uploadError,
    oncapture,
    onupload,
  }: {
    busy: boolean
    /** Why capturing the site failed (e.g. no browser on this server); empty when it didn't. */
    captureError: string
    /** Why the upload was refused (format, size); empty when it wasn't. */
    uploadError: string
    oncapture: (url: string) => void
    onupload: (file: File) => void
  } = $props()

  let url = $state('')
  let file = $state<File | null>(null)

  function chooseFile(event: Event & { currentTarget: HTMLInputElement }): void {
    file = event.currentTarget.files?.[0] ?? null
  }
</script>

<div class="grid gap-4 md:grid-cols-2">
  <section class="flex flex-col gap-2 rounded border p-4" data-testid="extract-from-url">
    <h3 class="text-sm font-semibold">From your website</h3>
    <label class="text-sm font-medium" for="extract-url">Site URL</label>
    <div class="flex gap-2">
      <input
        id="extract-url"
        class="w-full rounded border px-3 py-2 text-sm"
        type="url"
        placeholder="https://example.com"
        bind:value={url}
      />
      <button
        type="button"
        class="shrink-0 rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        disabled={busy || url.trim().length === 0}
        onclick={() => oncapture(url.trim())}
      >
        {busy ? 'Working…' : 'Capture & propose'}
      </button>
    </div>
    {#if captureError}
      <p class="text-sm text-red-800" role="alert" data-testid="capture-error">{captureError}</p>
    {/if}
  </section>

  <section class="flex flex-col gap-2 rounded border p-4" data-testid="extract-from-guide">
    <h3 class="text-sm font-semibold">From your brand guide</h3>
    <label class="text-sm font-medium" for="extract-guide">Brand guide</label>
    <div class="flex gap-2">
      <input
        id="extract-guide"
        class="w-full rounded border px-3 py-2 text-sm"
        type="file"
        accept={GUIDE_ACCEPT}
        onchange={chooseFile}
      />
      <button
        type="button"
        class="shrink-0 rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        disabled={busy || file === null}
        onclick={() => {
          if (file) onupload(file)
        }}
      >
        {busy ? 'Working…' : 'Upload & propose'}
      </button>
    </div>
    <p class="text-xs text-muted-foreground">{GUIDE_LIMITS_TEXT}</p>
    {#if uploadError}
      <p class="text-sm text-red-800" role="alert" data-testid="upload-error">{uploadError}</p>
    {/if}
  </section>
</div>
