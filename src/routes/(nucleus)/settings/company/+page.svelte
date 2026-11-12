<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { LOGO_TYPES, MAX_COMPANY_NAME_LENGTH, MAX_LOGO_BYTES } from '$lib/company/identity'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings → Company: the name and logo at the top left of the app (owner
   * and admins). Saving reloads the page data, so the shell shows the change
   * at once. Brand styles stay in Brand.
   */
  let { data, form }: PageProps = $props()

  const name = $derived(data.company.name ?? '')
  const initial = $derived((data.company.name ?? '?').slice(0, 1).toUpperCase())
  const nameResult = $derived(form?.action === 'saveName' ? form : null)
  const logoResult = $derived(form?.action === 'uploadLogo' || form?.action === 'removeLogo' ? form : null)
</script>

<svelte:head>
  <title>{docTitle('Company', 'Settings')}</title>
</svelte:head>

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
    <div class="flex items-center gap-3">
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
      <form
        method="post"
        action="?/uploadLogo"
        enctype="multipart/form-data"
        use:enhance
        class="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      >
        <input
          type="file"
          name="logo"
          accept={LOGO_TYPES.join(',')}
          required
          class="min-w-0 flex-1 text-xs text-foreground/70 file:mr-2 file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1 file:text-xs file:font-medium"
          data-testid="company-logo-file"
        />
        <Button type="submit" size="sm" variant="outline" data-testid="company-logo-upload">
          {data.company.logo ? 'Replace logo' : 'Upload logo'}
        </Button>
      </form>
    </div>
    {#if data.company.logo}
      <form method="post" action="?/removeLogo" use:enhance>
        <Button type="submit" size="sm" variant="ghost" data-testid="company-logo-remove">Remove logo</Button>
      </form>
    {/if}
    {#if logoResult?.error}
      <p class="text-xs text-destructive" role="alert">{logoResult.error}</p>
    {:else if logoResult?.ok}
      <p class="text-xs text-foreground/60" role="status">
        {logoResult.action === 'removeLogo' ? 'Logo removed.' : 'Logo saved.'}
      </p>
    {/if}
  </section>
</div>
