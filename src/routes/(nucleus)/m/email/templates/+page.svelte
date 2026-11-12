<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()
  const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
</script>

<svelte:head><title>{docTitle('Templates', 'Email')}</title></svelte:head>

<SectionHeader
  title="Templates"
  description={'Mails you send again and again — a welcome, a receipt, a reminder. Write them once with {{ variables }}, then send them by id from your app, the assistant or a flow.'}
/>

{#if data.email.isAdmin}
  <form
    method="POST"
    action="?/create"
    class="mt-5 grid max-w-3xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
    use:enhance
    data-testid="template-create"
  >
    <div class="grid gap-1.5">
      <Label for="template-name">New template</Label>
      <Input id="template-name" name="name" placeholder="e.g. Welcome" />
    </div>
    <div class="grid gap-1.5">
      <Label for="template-layout">Layout</Label>
      <select
        id="template-layout"
        name="layoutId"
        class="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
      >
        {#each data.layouts as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
        <option value="">No layout (a full document)</option>
      </select>
    </div>
    <Button type="submit">Create template</Button>
    {#if data.layouts.length === 0}
      <p class="text-xs text-muted-foreground sm:col-span-3">
        Tip: <a class="underline underline-offset-4" href={resolve('/m/email/layouts')}
          >create a layout</a
        > first — it puts your brand's header and footer around every template.
      </p>
    {/if}
    {#if form?.action === 'create' && 'error' in form}<p
        class="text-sm text-destructive sm:col-span-3"
        role="alert"
      >
        {form.error}
      </p>{/if}
  </form>
{/if}

{#if data.templates.length === 0}
  <p class="mt-6 text-sm text-muted-foreground" data-testid="templates-empty">No templates yet.</p>
{:else}
  <ul
    class="mt-6 divide-y divide-border rounded-lg border border-border"
    data-testid="templates-list"
  >
    {#each data.templates as t (t.id)}
      <li>
        <a
          class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/50 sm:px-5"
          href={resolve(`/m/email/templates/${t.id}`)}
          data-testid={`template-row-${t.name}`}
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{t.name}</span>
            <span class="block truncate text-xs text-muted-foreground">{t.subject}</span>
          </span>
          <span class="text-xs text-muted-foreground"
            >{t.format.toUpperCase()}{t.layout ? ` · in ${t.layout}` : ''} · edited {when(
              t.updatedAt,
            )}</span
          >
        </a>
      </li>
    {/each}
  </ul>
{/if}
