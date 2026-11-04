<script lang="ts">
  import { docTitle } from '$lib/shell/title'
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import BrandTokens from '$lib/components/email/brand-tokens.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: PageProps = $props()
</script>

<svelte:head><title>{docTitle('Layouts', 'Email')}</title></svelte:head>

<SectionHeader
  title="Layouts"
  description={'A layout is the frame around your mails — logo or name, colours, fonts, footer — built from your brand. Templates go inside its {{ content }} slot, so one change restyles every mail.'}
/>

<div class="mt-5 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
  <div class="min-w-0">
    {#if data.email.isAdmin}
      <form
        method="POST"
        action="?/create"
        class="flex max-w-xl flex-wrap items-end gap-3"
        use:enhance
        data-testid="layout-create"
      >
        <div class="grid min-w-56 flex-1 gap-1.5">
          <Label for="layout-name">New layout</Label>
          <Input id="layout-name" name="name" placeholder="e.g. Brand" />
        </div>
        <Button type="submit">Create layout</Button>
        {#if form?.action === 'create' && 'error' in form}<p
            class="w-full text-sm text-destructive"
            role="alert"
          >
            {form.error}
          </p>{/if}
      </form>
    {/if}
    {#if data.layouts.length === 0}
      <p class="mt-6 text-sm text-muted-foreground" data-testid="layouts-empty">
        No layouts yet. A new one starts from your brand.
      </p>
    {:else}
      <ul
        class="mt-6 divide-y divide-border rounded-lg border border-border"
        data-testid="layouts-list"
      >
        {#each data.layouts as l (l.id)}
          <li>
            <a
              class="flex items-center gap-4 px-4 py-3 hover:bg-muted/50 sm:px-5"
              href={resolve(`/m/email/layouts/${l.id}`)}
              data-testid={`layout-row-${l.name}`}
            >
              <span class="min-w-0 flex-1 truncate text-sm font-medium">{l.name}</span>
              <span class="text-xs text-muted-foreground"
                >{l.format.toUpperCase()} · {l.used} {l.used === 1 ? 'template' : 'templates'}</span
              >
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <BrandTokens brand={data.brand} />
</div>
