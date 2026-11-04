<script lang="ts">
  import { docTitle } from '$lib/shell/title'
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { SUPPRESSION_REASON_LABEL } from '../../../../../../modules/email/platform/suppression'

  let { data, form }: PageProps = $props()
  const feedback = (action: string) =>
    form && form.action === action
      ? (form as { ok?: boolean; error?: string; email?: string })
      : null
  const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
  const base = resolve('/m/email/suppression')
</script>

<svelte:head><title>{docTitle('Suppression', 'Email')}</title></svelte:head>

<SectionHeader
  title="Suppression"
  description="Nobody on this list gets mail from your company. Addresses that bounce permanently or mark your mail as spam are added automatically — this protects your sending reputation."
/>

{#if data.email.isAdmin}
  <form
    method="POST"
    action="?/add"
    class="mt-5 flex max-w-2xl flex-wrap items-end gap-3"
    use:enhance
    data-testid="suppression-add"
  >
    <div class="grid min-w-60 flex-1 gap-1.5">
      <Label for="suppress-email">Add an address</Label>
      <Input
        id="suppress-email"
        name="email"
        type="email"
        required
        placeholder="someone@example.com"
      />
    </div>
    <Button type="submit" variant="outline">Suppress</Button>
    {#if feedback('add')?.error}<p class="w-full text-sm text-destructive" role="alert">
        {feedback('add')?.error}
      </p>{/if}
  </form>
{/if}
{#if feedback('remove')?.error}<p class="mt-3 text-sm text-destructive" role="alert">
    {feedback('remove')?.error}
  </p>{/if}

<form method="GET" action={base} class="mt-6 flex items-center gap-2">
  <Input name="q" value={data.q} placeholder="Search addresses" class="h-9 w-64" />
  <Button type="submit" size="sm" variant="ghost">Search</Button>
</form>

{#if data.suppressions.length === 0}
  <p class="mt-4 text-sm text-muted-foreground" data-testid="suppression-empty">
    {data.q ? 'No address matches.' : 'Nobody is suppressed.'}
  </p>
{:else}
  <ul
    class="mt-4 divide-y divide-border rounded-lg border border-border"
    data-testid="suppression-list"
  >
    {#each data.suppressions as s (s.email)}
      <li
        class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:px-5"
        data-testid={`suppressed-${s.email}`}
      >
        <span class="min-w-0 flex-1 truncate text-sm">{s.email}</span>
        <span class="text-xs text-muted-foreground"
          >{SUPPRESSION_REASON_LABEL[s.reason] ?? s.reason} · {when(s.createdAt)}</span
        >
        {#if data.email.isAdmin}
          <form method="POST" action="?/remove" use:enhance>
            <input type="hidden" name="email" value={s.email} />
            <Button type="submit" size="sm" variant="ghost">Remove</Button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
