<script lang="ts">
  import type { PageProps } from './$types'
  import { onMount, untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import BrandTokens from '$lib/components/email/brand-tokens.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: PageProps = $props()
  const initial = untrack(() => data.layout)
  let name = $state(initial.name)
  let format = $state<string>(initial.format)
  let body = $state(initial.body)
  let preview = $state<{ html?: string; problems?: string[]; missing?: string[]; error?: string }>({})
  let busy = $state(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  /** Only the newest request may paint the preview (a slow earlier one must not overwrite it). */
  let seq = 0
  async function refreshPreview() {
    const mine = ++seq
    const res = await fetch('/api/mail/templates/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: { format, body } }),
    })
    const next = (await res.json().catch(() => ({ error: `Preview failed (HTTP ${res.status}).` }))) as typeof preview
    if (mine === seq) preview = next
  }
  function edited() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refreshPreview(), 400)
  }
  onMount(() => {
    void refreshPreview()
  })
  const feedback = (action: string) => (form && form.action === action ? (form as { ok?: boolean; error?: string }) : null)
</script>

<div class="mt-8">
  <a class="text-[13px] text-muted-foreground hover:text-foreground" href={resolve('/m/email/layouts')}>← Back to layouts</a>
</div>

<form
  method="POST"
  action="?/save"
  class="mt-3 grid gap-8 2xl:grid-cols-2"
  data-testid="layout-editor"
  use:enhance={() => {
    busy = true
    return async ({ update }) => {
      await update({ reset: false })
      busy = false
    }
  }}
>
  <div class="flex min-w-0 flex-col gap-4">
    <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
      <div class="grid gap-1.5">
        <Label for="layout-name">Name</Label>
        <Input id="layout-name" name="name" bind:value={name} required />
      </div>
      <div class="grid gap-1.5">
        <Label for="layout-format">Format</Label>
        <select
          id="layout-format"
          name="format"
          value={format}
          onchange={(e) => {
            format = e.currentTarget.value
            edited()
          }}
          class="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="mjml">MJML</option>
          <option value="html">HTML</option>
        </select>
      </div>
    </div>
    <div class="grid gap-1.5">
      <Label for="layout-body">Source</Label>
      <textarea
        id="layout-body"
        name="body"
        rows="24"
        spellcheck="false"
        class="rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        bind:value={body}
        oninput={edited}
        data-testid="layout-body"
      ></textarea>
      <p class="text-xs text-muted-foreground">Put <code class="font-mono">{'{{ content }}'}</code> exactly once: each template goes there.</p>
    </div>
    {#if data.usedBy.length > 0}
      <p class="text-xs text-muted-foreground">
        Used by {#each data.usedBy as t, i (t.id)}{i > 0 ? ', ' : ''}<a class="underline underline-offset-4" href={resolve(`/m/email/templates/${t.id}`)}>{t.name}</a>{/each}.
      </p>
    {/if}
    {#if data.email.isAdmin}
      <div class="flex items-center gap-2">
        <Button type="submit" disabled={busy} data-testid="layout-save">Save</Button>
        <Button
          type="submit"
          formaction="?/delete"
          variant="ghost"
          class="ml-auto text-destructive"
          onclick={(e) => {
            if (!confirm(`Delete the layout “${name}”?`)) e.preventDefault()
          }}>Delete</Button
        >
      </div>
      {#if feedback('save')?.ok}<p class="text-sm" role="status" data-testid="layout-saved">Saved.</p>{/if}
      {#if feedback('save')?.error || feedback('delete')?.error}
        <p class="text-sm text-destructive" role="alert">{feedback('save')?.error ?? feedback('delete')?.error}</p>
      {/if}
    {/if}
  </div>

  <div class="flex min-w-0 flex-col gap-4">
    <h3 class="text-sm font-medium">Preview</h3>
    {#if preview.error}<p class="text-sm text-destructive" role="alert">{preview.error}</p>{/if}
    {#each preview.problems ?? [] as p (p)}<p class="font-mono text-xs text-destructive">{p}</p>{/each}
    {#if preview.missing && preview.missing.length > 0}<p class="text-xs text-muted-foreground">Needs a value: {preview.missing.join(', ')}</p>{/if}
    <iframe title="Layout preview" class="h-[32rem] w-full rounded-lg border border-border bg-white" sandbox="" srcdoc={preview.html ?? ''} data-testid="layout-preview"></iframe>
    <BrandTokens brand={data.brand} />
  </div>
</form>
