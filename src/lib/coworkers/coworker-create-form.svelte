<script lang="ts">
  import type { ActionFeedback as Feedback } from './action-result'
  import type { ChatModelOption } from './model-family'
  import type { SubmitFunction } from '@sveltejs/kit'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { m } from '$lib/paraglide/messages.js'
  import ActionFeedback from './action-feedback.svelte'
  import { draftFromTemplate, emptyDraft, type CardDraft, type TemplateLike } from './card-draft'
  import CoworkerFields from './coworker-fields.svelte'

  /**
   * Create an AI co-worker (coworkers.create, plan/phase-ai-coworkers.md C5):
   * pick a template — its title, accountabilities, lens, suggested model and
   * daily cap fill the form, each editable — or start blank. The tool always
   * asks for approval; the admin's click is that approval.
   */
  let {
    templates,
    models,
    seats,
    feedback = null,
  }: {
    templates: TemplateLike[]
    models: ChatModelOption[]
    seats: { id: string; name: string; kind: 'human' | 'coworker' }[]
    feedback?: Feedback | null
  } = $props()

  /** '' = blank (no template). */
  let templateId = $state('')
  let card = $state<CardDraft>(emptyDraft())

  function pickTemplate(id: string) {
    templateId = id
    const t = templates.find((x) => x.id === id)
    const keep = { reportsTo: card.reportsTo, avatarPreset: card.avatarPreset, avatarSha256: card.avatarSha256 }
    card = t ? draftFromTemplate(t, keep) : { ...emptyDraft(), ...keep }
  }

  /** A created co-worker clears the form (the list above shows it); a refusal keeps what was typed. */
  const clearWhenCreated: SubmitFunction = () => async ({ result, update }) => {
    await update({ reset: false })
    if (result.type === 'success' && result.data?.ok === true) {
      templateId = ''
      card = emptyDraft()
    }
  }
</script>

<form method="post" action="?/create" use:enhance={clearWhenCreated} class="space-y-5" data-testid="coworker-create-form">
  <fieldset class="space-y-2">
    <legend class="text-sm font-medium">{m.coworkers_template_legend()}</legend>
    <div class="grid gap-2 sm:grid-cols-2" data-testid="coworker-templates">
      {#each templates as t (t.id)}
        <label
          class={[
            'flex cursor-pointer gap-2 rounded-lg border p-3 text-sm focus-within:ring-2 focus-within:ring-ring',
            templateId === t.id ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-foreground/[0.03]',
          ]}
        >
          <input
            type="radio"
            name="template_id"
            value={t.id}
            checked={templateId === t.id}
            onchange={() => pickTemplate(t.id)}
            class="mt-0.5"
            data-testid="coworker-template"
          />
          <span class="min-w-0">
            <span class="block font-medium">{t.title}</span>
            <span class="block text-xs text-muted-foreground">{t.accountabilities[0] ?? ''}</span>
          </span>
        </label>
      {/each}
      <label
        class={[
          'flex cursor-pointer gap-2 rounded-lg border p-3 text-sm focus-within:ring-2 focus-within:ring-ring',
          templateId === '' ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-foreground/[0.03]',
        ]}
      >
        <input
          type="radio"
          name="template_id"
          value=""
          checked={templateId === ''}
          onchange={() => pickTemplate('')}
          class="mt-0.5"
          data-testid="coworker-template-blank"
        />
        <span class="min-w-0">
          <span class="block font-medium">{m.coworkers_template_blank()}</span>
          <span class="block text-xs text-muted-foreground">{m.coworkers_template_blank_hint()}</span>
        </span>
      </label>
    </div>
  </fieldset>

  <CoworkerFields idPrefix="new-coworker" bind:card {models} {seats} />

  <div class="flex flex-wrap items-center gap-3">
    <Button type="submit" data-testid="coworker-create">{m.coworkers_create()}</Button>
    <p class="text-xs text-muted-foreground">{m.coworkers_create_hint()}</p>
  </div>
  <ActionFeedback {feedback} done={m.coworkers_created()} testid="coworker-create-feedback" />
</form>
