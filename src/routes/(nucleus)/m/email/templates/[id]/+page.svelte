<script lang="ts">
  import type { PageProps } from './$types'
  import { onMount, untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import CopyButton from '$lib/components/email/copy-button.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'
  import { templateVariables } from '../../../../../../../modules/email/platform/templates/variables'

  let { data, form }: PageProps = $props()
  const initial = untrack(() => data.template)
  let name = $state(initial.name)
  let subject = $state(initial.subject)
  let layoutId = $state(initial.layoutId ?? '')
  let format = $state<string>(initial.format)
  let body = $state(initial.body)
  let textBody = $state(initial.textBody ?? '')
  let sample = $state<Record<string, string>>({ ...initial.sampleVariables })

  const layout = $derived(data.layouts.find((l) => l.id === layoutId) ?? null)
  const variables = $derived(templateVariables(subject, body, textBody, layout?.body ?? ''))
  /** Only the values of variables the template uses are kept. */
  const sampleJson = $derived(
    JSON.stringify(
      Object.fromEntries(
        variables
          .filter((v) => sample[v.name] !== undefined && sample[v.name] !== '')
          .map((v) => [v.name, sample[v.name]!]),
      ),
    ),
  )

  type Preview = {
    subject?: string
    html?: string
    text?: string
    missing?: string[]
    problems?: string[]
    error?: string
  }
  let preview = $state<Preview>({})
  let view = $state<'html' | 'text'>('html')
  let busy = $state<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null

  /** Only the newest request may paint the preview (a slow earlier one must not overwrite it). */
  let seq = 0
  async function refreshPreview() {
    const mine = ++seq
    const res = await fetch('/api/mail/templates/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          name,
          subject,
          format,
          body,
          textBody: textBody || null,
          layoutId: layoutId || null,
        },
        variables: JSON.parse(sampleJson) as Record<string, string>,
      }),
    })
    const next =
      ((await res
        .json()
        .catch(() => ({ error: `Preview failed (HTTP ${res.status}).` }))) as Preview) ?? {}
    if (mine === seq) preview = next
  }

  /** Debounced: every edit re-renders the preview half a second after typing stops. */
  function edited() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refreshPreview(), 400)
  }

  function pickLayout(id: string) {
    layoutId = id
    const l = data.layouts.find((x) => x.id === id)
    if (l) format = l.format
    edited()
  }

  onMount(() => {
    void refreshPreview()
  })

  const feedback = (action: string) =>
    form && form.action === action
      ? (form as {
          ok?: boolean
          error?: string
          sentTo?: string
          status?: string
          problems?: string[]
        })
      : null
  const enhanced = (action: string) => () => {
    busy = action
    return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await update({ reset: false })
      busy = null
    }
  }

  const apiExample = $derived(
    `curl -X POST ${data.endpoint} \\\n` +
      `  -H "Authorization: Bearer $EE_API_KEY" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '${JSON.stringify({ to: 'someone@example.com', templateId: data.template.id, variables: JSON.parse(sampleJson) })}'`,
  )
  const inputClass =
    'rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
</script>

<svelte:head><title>{docTitle('Templates', 'Email')}</title></svelte:head>

<div class="mt-8">
  <a
    class="text-[13px] text-muted-foreground hover:text-foreground"
    href={resolve('/m/email/templates')}>← Back to templates</a
  >
</div>

<form
  method="POST"
  action="?/save"
  class="mt-3"
  use:enhance={enhanced('save')}
  data-testid="template-editor"
>
  <input type="hidden" name="format" value={format} />
  <input type="hidden" name="sampleVariables" value={sampleJson} />
  <div class="grid gap-8 2xl:grid-cols-2">
    <div class="flex min-w-0 flex-col gap-4">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="tpl-name">Name</Label>
          <Input id="tpl-name" name="name" bind:value={name} required />
        </div>
        <div class="grid gap-1.5">
          <Label for="tpl-layout">Layout</Label>
          <select
            id="tpl-layout"
            name="layoutId"
            value={layoutId}
            onchange={(e) => pickLayout(e.currentTarget.value)}
            class="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">No layout</option>
            {#each data.layouts as l (l.id)}<option value={l.id}
                >{l.name} ({l.format.toUpperCase()})</option
              >{/each}
          </select>
        </div>
      </div>
      <div class="grid gap-1.5">
        <Label for="tpl-subject">Subject</Label>
        <Input
          id="tpl-subject"
          name="subject"
          bind:value={subject}
          oninput={edited}
          required
          data-testid="tpl-subject"
        />
      </div>
      <div class="grid gap-1.5">
        <div class="flex items-center justify-between gap-3">
          <Label for="tpl-body">Body ({format.toUpperCase()})</Label>
          {#if !layout}
            <select
              aria-label="Format"
              value={format}
              onchange={(e) => {
                format = e.currentTarget.value
                edited()
              }}
              class="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="mjml">MJML</option>
              <option value="html">HTML</option>
            </select>
          {/if}
        </div>
        <textarea
          id="tpl-body"
          name="body"
          rows="18"
          class={inputClass}
          bind:value={body}
          oninput={edited}
          spellcheck="false"
          data-testid="tpl-body"></textarea>
        <p class="text-xs text-muted-foreground">
          {#if format === 'mjml'}
            <a
              class="underline underline-offset-4"
              href="https://documentation.mjml.io/"
              target="_blank"
              rel="noopener noreferrer">MJML</a
            >
            builds mail that looks right in every inbox.{layout
              ? ' Write sections (mj-section); the layout adds the rest.'
              : ''}
          {:else}
            Plain HTML. Inline styles work best in email.
          {/if}
          Use <code class="font-mono">{'{{ name }}'}</code> for a value,
          <code class="font-mono">{'{{ name | "fallback" }}'}</code>
          for an optional one, <code class="font-mono">{'{{ brand.primary }}'}</code> for your brand.
        </p>
      </div>
      <details class="rounded-md border border-border px-3 py-2">
        <summary class="cursor-pointer text-sm">Plain-text version (optional)</summary>
        <textarea
          name="textBody"
          rows="5"
          class="mt-2 w-full {inputClass}"
          bind:value={textBody}
          oninput={edited}
          placeholder="Leave empty to build it from the HTML."></textarea>
      </details>

      <section
        aria-labelledby="vars-heading"
        class="rounded-lg border border-border px-4 py-3"
        data-testid="tpl-variables"
      >
        <h3 id="vars-heading" class="text-sm font-medium">Variables</h3>
        {#if variables.length === 0}
          <p class="mt-1 text-sm text-muted-foreground">This template uses no variables.</p>
        {:else}
          <p class="mt-1 text-xs text-muted-foreground">
            Sample values for the preview and the test mail. Senders pass real ones.
          </p>
          <div class="mt-3 grid gap-2 sm:grid-cols-2">
            {#each variables as v (v.name)}
              <label class="grid gap-1 text-xs">
                <span><code class="font-mono">{v.name}</code> {v.required ? '' : '(optional)'}</span
                >
                <Input
                  bind:value={sample[v.name]}
                  oninput={edited}
                  data-testid={`tpl-var-${v.name}`}
                />
              </label>
            {/each}
          </div>
        {/if}
      </section>

      {#if data.email.isAdmin}
        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy === 'save'} data-testid="tpl-save">Save</Button>
          <Button
            type="submit"
            formaction="?/test"
            variant="outline"
            disabled={busy === 'test'}
            data-testid="tpl-test">Save and send me a test</Button
          >
          <Button
            type="submit"
            formaction="?/delete"
            variant="ghost"
            class="ml-auto text-destructive"
            onclick={(e) => {
              if (!confirm(`Delete the template “${name}”? Apps or flows that send it will fail.`))
                e.preventDefault()
            }}>Delete</Button
          >
        </div>
        {#if feedback('save')?.ok}<p class="text-sm" role="status" data-testid="tpl-saved">
            Saved.
          </p>{/if}
        {#if feedback('test')?.ok}
          <p class="text-sm" role="status" data-testid="tpl-test-sent">
            {feedback('test')?.status === 'suppressed'
              ? `Not sent: ${feedback('test')?.sentTo} is suppressed.`
              : `Sent to ${feedback('test')?.sentTo}.`}
          </p>
        {/if}
        {#each ['save', 'test'] as a (a)}
          {#if feedback(a)?.error}
            <div class="text-sm text-destructive" role="alert">
              {feedback(a)?.error}
              {#each feedback(a)?.problems ?? [] as p (p)}<p class="font-mono text-xs">
                  {p}
                </p>{/each}
            </div>
          {/if}
        {/each}
      {/if}
    </div>

    <div class="flex min-w-0 flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-medium">Preview</h3>
        <div class="flex gap-1 text-[13px]">
          <button
            type="button"
            class="rounded px-2 py-1 {view === 'html'
              ? 'bg-muted font-medium'
              : 'text-muted-foreground'}"
            onclick={() => (view = 'html')}>HTML</button
          >
          <button
            type="button"
            class="rounded px-2 py-1 {view === 'text'
              ? 'bg-muted font-medium'
              : 'text-muted-foreground'}"
            onclick={() => (view = 'text')}>Text</button
          >
        </div>
      </div>
      {#if preview.error}
        <p class="text-sm text-destructive" role="alert">{preview.error}</p>
      {:else}
        <p class="truncate text-sm" data-testid="tpl-preview-subject">
          <span class="text-muted-foreground">Subject:</span>
          {preview.subject ?? ''}
        </p>
        {#if preview.missing && preview.missing.length > 0}
          <p class="text-xs text-muted-foreground" data-testid="tpl-preview-missing">
            Needs a value: {preview.missing.join(', ')}
          </p>
        {/if}
        {#each preview.problems ?? [] as p (p)}<p class="font-mono text-xs text-destructive">
            {p}
          </p>{/each}
        {#if view === 'html'}
          <iframe
            title="Template preview"
            class="h-[36rem] w-full rounded-lg border border-border bg-white"
            sandbox=""
            srcdoc={preview.html ?? ''}
            data-testid="tpl-preview"
          ></iframe>
        {:else}
          <pre
            class="h-[36rem] overflow-auto rounded-lg border border-border px-4 py-3 text-xs whitespace-pre-wrap">{preview.text ??
              ''}</pre>
        {/if}
      {/if}

      <details class="rounded-lg border border-border px-4 py-3">
        <summary class="cursor-pointer text-sm font-medium"
          >Send this template from your app</summary
        >
        <div class="relative mt-3">
          <pre
            class="overflow-x-auto rounded-md bg-muted px-3 py-2 pr-10 font-mono text-[11px] leading-relaxed"
            data-testid="tpl-api-example">{apiExample}</pre>
          <div class="absolute top-1.5 right-1.5">
            <CopyButton value={apiExample} label="Copy the example" />
          </div>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          Template id <code class="font-mono">{data.template.id}</code>. Keys and the rest of the
          request: <a class="underline underline-offset-4" href={resolve('/m/email/api')}>API</a>.
        </p>
      </details>
    </div>
  </div>
</form>
