<script lang="ts">
  import type { PageProps } from './$types'
  import { applyAction, deserialize, enhance } from '$app/forms'
  import { invalidateAll } from '$app/navigation'
  import { LOGO_TYPES, MAX_COMPANY_NAME_LENGTH, MAX_LOGO_BYTES, refuseLogoFile } from '$lib/company/identity'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings → Company: the name and logo at the top left of the app (owner
   * and admins). Saving reloads the page data, so the shell shows the change
   * at once. Brand styles stay in Brand.
   *
   * The logo uploads as soon as a file arrives: picked (the button opens the
   * picker), dropped onto the logo area, or pasted. Drop and paste need no
   * folder access, so they still work when macOS has refused Chrome the
   * Desktop or Documents folder.
   */
  let { data, form }: PageProps = $props()

  const name = $derived(data.company.name ?? '')
  const initial = $derived((data.company.name ?? '?').slice(0, 1).toUpperCase())
  const nameResult = $derived(form?.action === 'saveName' ? form : null)
  const logoResult = $derived(form?.action === 'uploadLogo' || form?.action === 'removeLogo' ? form : null)

  /** What this page knows before the server answers: a file on its way, or why it was not sent. */
  type LogoLocal = { kind: 'uploading'; fileName: string } | { kind: 'refused'; error: string }
  let logoLocal = $state<LogoLocal | null>(null)
  let dragging = $state(false)
  let fileInput: HTMLInputElement | undefined = $state()
  const uploading = $derived(logoLocal?.kind === 'uploading')

  const UNREACHABLE = 'The logo did not reach the server. Check the connection and try again.'

  async function uploadLogo(file: File) {
    if (uploading) return
    const refused = refuseLogoFile(file.type, file.size)
    if (refused) {
      logoLocal = { kind: 'refused', error: refused.error }
      return
    }
    logoLocal = { kind: 'uploading', fileName: file.name }
    const body = new FormData()
    body.set('logo', file)
    let text: string
    try {
      const response = await fetch('?/uploadLogo', {
        method: 'POST',
        body,
        headers: { 'x-sveltekit-action': 'true' },
      })
      text = await response.text()
    } catch {
      logoLocal = { kind: 'refused', error: UNREACHABLE }
      return
    }
    // Same as the default use:enhance: reload the data on success, then show the action's result.
    const result = deserialize(text)
    if (result.type === 'success') await invalidateAll()
    await applyAction(result)
    logoLocal = null
  }

  function onPicked(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget
    const file = input.files?.[0]
    // Clear it, so picking the same file again is a change too.
    input.value = ''
    if (file) void uploadLogo(file)
  }

  function onDragOver(event: DragEvent) {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dragging = true
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    const file = event.dataTransfer?.files[0]
    if (file) void uploadLogo(file)
  }

  /** A pasted file anywhere on the page is a logo, except while typing in a field. */
  function onPaste(event: ClipboardEvent) {
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)
    ) {
      return
    }
    const file = event.clipboardData?.files[0]
    if (!file) return
    event.preventDefault()
    void uploadLogo(file)
  }
</script>

<svelte:head>
  <title>{docTitle('Company', 'Settings')}</title>
</svelte:head>

<svelte:document onpaste={onPaste} />

<h2 class="text-base font-semibold tracking-tight">Company</h2>
<p class="mt-1 text-sm text-foreground/60">
  The company's name and logo, shown at the top left of the app, on invites and wherever the company is named.
</p>

<div class="mt-8 space-y-6" data-testid="settings-company">
  <form
    method="post"
    action="?/saveName"
    use:enhance={() =>
      async ({ update }) => {
        await update({ reset: false })
      }}
    class="space-y-3 rounded-lg border border-border p-4"
    data-testid="company-name-form"
  >
    <label class="block space-y-1.5">
      <span class="text-sm font-medium">Company name</span>
      <Input
        name="name"
        value={name}
        required
        maxlength={MAX_COMPANY_NAME_LENGTH}
        autocomplete="organization"
        placeholder="Your company"
        data-testid="company-name-input"
      />
    </label>
    <Button type="submit" size="sm" data-testid="company-name-save">Save name</Button>
    {#if nameResult?.error}
      <p class="text-xs text-destructive" role="alert">{nameResult.error}</p>
    {:else if nameResult?.ok}
      <p class="text-xs text-foreground/60" role="status">Saved.</p>
    {/if}
  </form>

  <section class="space-y-4 rounded-lg border border-border p-4" data-testid="company-logo">
    <div>
      <h3 class="text-sm font-medium">Logo</h3>
      <p class="text-xs text-foreground/60">
        PNG, JPEG, SVG or WebP, up to {MAX_LOGO_BYTES / 1024} KB. Without a logo the app shows the
        name's first letter.
      </p>
    </div>
    <div
      role="group"
      aria-label="Logo: drop an image here"
      class="flex items-center gap-3 rounded-md border border-dashed p-3 {dragging
        ? 'border-ring bg-muted'
        : 'border-border'}"
      ondragover={onDragOver}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
      data-testid="company-logo-drop"
    >
      {#if data.company.logo}
        <img
          src={data.company.logo.url}
          alt="Company logo"
          class="size-12 shrink-0 rounded-md border border-border object-contain"
          data-testid="company-logo-preview"
        />
      {:else}
        <span
          class="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary text-lg font-semibold text-primary-foreground"
          aria-hidden="true"
          data-testid="company-logo-initial">{initial}</span
        >
      {/if}
      <div class="min-w-0 flex-1 space-y-1.5">
        <input
          bind:this={fileInput}
          type="file"
          name="logo"
          accept={LOGO_TYPES.join(',')}
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          onchange={onPicked}
          data-testid="company-logo-file"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={uploading}
          onclick={() => fileInput?.click()}
          data-testid="company-logo-upload"
        >
          {data.company.logo ? 'Replace logo' : 'Upload logo'}
        </Button>
        <p class="text-xs text-muted-foreground">Or drop an image here, or paste one (⌘V / Ctrl+V).</p>
      </div>
    </div>
    {#if data.company.logo}
      <form
        method="post"
        action="?/removeLogo"
        use:enhance={() => {
          // The answer to this click replaces an earlier refusal shown here.
          logoLocal = null
        }}
      >
        <Button type="submit" size="sm" variant="ghost" disabled={uploading} data-testid="company-logo-remove"
          >Remove logo</Button
        >
      </form>
    {/if}
    {#if logoLocal?.kind === 'uploading'}
      <p class="text-xs text-muted-foreground" role="status" data-testid="company-logo-status">
        Uploading {logoLocal.fileName}…
      </p>
    {:else if logoLocal?.kind === 'refused'}
      <p class="text-xs text-destructive" role="alert">{logoLocal.error}</p>
    {:else if logoResult?.error}
      <p class="text-xs text-destructive" role="alert">{logoResult.error}</p>
    {:else if logoResult?.ok}
      <p class="text-xs text-foreground/60" role="status">
        {logoResult.action === 'removeLogo' ? 'Logo removed.' : 'Logo saved.'}
      </p>
    {/if}
    <p class="text-xs text-muted-foreground" data-testid="company-logo-mac-hint">
      On a Mac, if the file picker won't open your folders: allow it in System Settings → Privacy &amp; Security →
      Files and Folders → Google Chrome. Dropping or pasting an image works without that.
    </p>
  </section>
</div>
