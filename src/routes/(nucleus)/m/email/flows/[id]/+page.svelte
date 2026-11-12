<script lang="ts">
  import type { FlowStep } from '../../../../../../../modules/email/platform/flows/engine'
  import type { PageProps } from './$types'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import Clock from '@lucide/svelte/icons/clock'
  import Mail from '@lucide/svelte/icons/mail'
  import Trash from '@lucide/svelte/icons/trash-2'
  import UserPlus from '@lucide/svelte/icons/user-plus'
  import { untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()
  const initial = untrack(() => data.flow)
  let name = $state(initial.name)
  let listId = $state(initial.triggerListId ?? '')
  let steps = $state<FlowStep[]>(structuredClone(initial.steps))
  let busy = $state(false)
  const stepsJson = $derived(JSON.stringify(steps))
  const isAdmin = $derived(data.email.isAdmin)

  const newId = () => Math.random().toString(36).slice(2, 10)
  function addWait() {
    steps.push({ id: newId(), type: 'wait', amount: 1, unit: 'days' })
  }
  function addSend() {
    const first = data.templates[0]
    if (!first) return
    steps.push({ id: newId(), type: 'send', templateId: first.id })
  }
  function move(i: number, by: -1 | 1) {
    const j = i + by
    if (j < 0 || j >= steps.length) return
    ;[steps[i], steps[j]] = [steps[j]!, steps[i]!]
  }

  const feedback = (action: string) =>
    form && form.action === action ? (form as { ok?: boolean; error?: string }) : null
  const STATUS: Record<string, string> = {
    draft: 'Draft — not running',
    active: 'Running',
    paused: 'Paused',
  }
  const EVENT: Record<string, string> = {
    entered: 'Joined the flow',
    email_sent: 'Mail sent',
    waiting: 'Waiting',
    completed: 'Finished',
    exited: 'Left the flow',
    error: 'Problem',
  }
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const stepNo = (stepId: string | null) =>
    stepId ? steps.findIndex((s) => s.id === stepId) + 1 || null : null
  function detailText(d: Record<string, unknown> | null): string {
    if (!d) return ''
    if (typeof d.until === 'string') return `until ${when(d.until)}`
    if (typeof d.message === 'string') return d.message
    if (typeof d.reason === 'string') return d.reason
    return ''
  }
</script>

<svelte:head><title>{docTitle('Flows', 'Email')}</title></svelte:head>

<div class="mt-8">
  <a
    class="text-[13px] text-muted-foreground hover:text-foreground"
    href={resolve('/m/email/flows')}>← Back to flows</a
  >
  <div class="mt-2 flex flex-wrap items-center gap-3">
    <h2 class="text-base font-semibold tracking-tight">{data.flow.name}</h2>
    <span
      class="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium"
      data-testid="flow-status">{STATUS[data.flow.status]}</span
    >
    {#if isAdmin}
      <form method="POST" action="?/status" use:enhance>
        {#if data.flow.status === 'active'}
          <input type="hidden" name="status" value="paused" />
          <Button type="submit" size="sm" variant="outline" data-testid="flow-pause">Pause</Button>
        {:else}
          <input type="hidden" name="status" value="active" />
          <Button type="submit" size="sm" data-testid="flow-activate"
            >{data.flow.status === 'paused' ? 'Resume' : 'Start the flow'}</Button
          >
        {/if}
      </form>
    {/if}
  </div>
  {#if feedback('status')?.error}<p class="mt-2 text-sm text-destructive" role="alert">
      {feedback('status')?.error}
    </p>{/if}
</div>

<div class="mt-6 grid gap-10 xl:grid-cols-[minmax(0,40rem)_minmax(0,1fr)]">
  <form
    method="POST"
    action="?/save"
    class="flex flex-col gap-4"
    data-testid="flow-editor"
    use:enhance={() => {
      busy = true
      return async ({ update }) => {
        await update({ reset: false })
        busy = false
      }
    }}
  >
    <input type="hidden" name="steps" value={stepsJson} />
    <div class="grid gap-1.5">
      <Label for="flow-name">Name</Label>
      <Input id="flow-name" name="name" bind:value={name} required disabled={!isAdmin} />
    </div>

    <ol class="flex flex-col">
      <li class="flex items-start gap-3 rounded-lg border border-border px-4 py-3">
        <UserPlus class="mt-1.5 size-4 shrink-0 text-muted-foreground" />
        <div class="grid flex-1 gap-1.5">
          <Label for="flow-list">When someone joins</Label>
          <select
            id="flow-list"
            name="listId"
            bind:value={listId}
            disabled={!isAdmin}
            class="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">Choose a list</option>
            {#each data.lists as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
          </select>
        </div>
      </li>
      {#each steps as step, i (step.id)}
        <li class="ml-6 h-4 border-l border-border" aria-hidden="true"></li>
        <li
          class="flex items-start gap-3 rounded-lg border border-border px-4 py-3"
          data-testid={`flow-step-${i + 1}`}
        >
          {#if step.type === 'wait'}
            <Clock class="mt-1.5 size-4 shrink-0 text-muted-foreground" />
            <div class="flex flex-1 flex-wrap items-center gap-2 text-sm">
              <span>Wait</span>
              <Input
                type="number"
                min="1"
                max="365"
                class="h-8 w-20"
                bind:value={step.amount}
                disabled={!isAdmin}
                aria-label="How long"
              />
              <select
                bind:value={step.unit}
                disabled={!isAdmin}
                class="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                aria-label="Unit"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          {:else}
            <Mail class="mt-1.5 size-4 shrink-0 text-muted-foreground" />
            <div class="flex flex-1 flex-wrap items-center gap-2 text-sm">
              <span>Send</span>
              <select
                bind:value={step.templateId}
                disabled={!isAdmin}
                class="h-8 min-w-40 rounded-md border border-input bg-transparent px-2 text-sm"
                aria-label="Template"
              >
                {#each data.templates as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
              </select>
              <span>from</span>
              <select
                value={step.from ?? ''}
                onchange={(e) => {
                  const v = e.currentTarget.value
                  if (step.type === 'send') step.from = v || undefined
                }}
                disabled={!isAdmin}
                class="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                aria-label="Sender"
              >
                <option value="">the default sender</option>
                {#each data.senders as s (s)}<option value={s}>{s}</option>{/each}
              </select>
            </div>
          {/if}
          {#if isAdmin}
            <div class="flex shrink-0 gap-0.5">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                class="size-7"
                onclick={() => move(i, -1)}
                aria-label="Move up"><ArrowUp class="size-3.5" /></Button
              >
              <Button
                type="button"
                size="icon"
                variant="ghost"
                class="size-7"
                onclick={() => move(i, 1)}
                aria-label="Move down"><ArrowDown class="size-3.5" /></Button
              >
              <Button
                type="button"
                size="icon"
                variant="ghost"
                class="size-7"
                onclick={() => steps.splice(i, 1)}
                aria-label="Remove step"><Trash class="size-3.5" /></Button
              >
            </div>
          {/if}
        </li>
      {/each}
    </ol>

    {#if isAdmin}
      <div class="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={addSend}
          disabled={data.templates.length === 0}
          data-testid="flow-add-send">+ Send a template</Button
        >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={addWait}
          data-testid="flow-add-wait">+ Wait</Button
        >
      </div>
      {#if data.templates.length === 0}
        <p class="text-xs text-muted-foreground">
          To send mail, <a class="underline underline-offset-4" href={resolve('/m/email/templates')}
            >create a template</a
          > first.
        </p>
      {/if}
      <div class="flex items-center gap-2">
        <Button type="submit" disabled={busy} data-testid="flow-save">Save</Button>
        <Button
          type="submit"
          formaction="?/delete"
          variant="ghost"
          class="ml-auto text-destructive"
          onclick={(e) => {
            if (!confirm(`Delete the flow “${name}”?`)) e.preventDefault()
          }}>Delete</Button
        >
      </div>
      {#if feedback('save')?.ok}<p class="text-sm" role="status" data-testid="flow-saved">
          Saved.
        </p>{/if}
      {#if feedback('save')?.error}<p class="text-sm text-destructive" role="alert">
          {feedback('save')?.error}
        </p>{/if}
    {/if}
  </form>

  <div class="flex min-w-0 flex-col gap-8">
    <section aria-labelledby="people-heading">
      <h3 id="people-heading" class="text-sm font-medium">People in this flow</h3>
      {#if data.enrollments.length === 0}
        <p class="mt-2 text-sm text-muted-foreground">
          Nobody yet. People join when they subscribe to the list while the flow runs.
        </p>
      {:else}
        <ul
          class="mt-2 divide-y divide-border rounded-lg border border-border"
          data-testid="flow-enrollments"
        >
          {#each data.enrollments as e (e.id)}
            <li class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
              <span class="min-w-0 flex-1 truncate">{e.email}</span>
              <span class="text-xs text-muted-foreground" data-testid="enrollment-state">
                {e.status === 'completed'
                  ? 'Finished'
                  : e.status === 'exited'
                    ? 'Left the flow'
                    : e.waitUntil
                      ? `Waiting until ${when(e.waitUntil)}`
                      : `At step ${e.stepIndex + 1}`}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
    <section aria-labelledby="log-heading">
      <h3 id="log-heading" class="text-sm font-medium">What happened</h3>
      {#if data.log.length === 0}
        <p class="mt-2 text-sm text-muted-foreground">Nothing yet.</p>
      {:else}
        <ol class="mt-2 flex flex-col gap-2 text-sm" data-testid="flow-log">
          {#each data.log as l (l.id)}
            <li class="flex flex-wrap gap-x-2" data-testid={`flow-log-${l.event}`}>
              <span class="w-36 shrink-0 text-xs text-muted-foreground">{when(l.at)}</span>
              <span class={l.event === 'error' ? 'text-destructive' : ''}
                >{EVENT[l.event] ?? l.event}</span
              >
              {#if stepNo(l.stepId)}<span class="text-muted-foreground"
                  >· step {stepNo(l.stepId)}</span
                >{/if}
              {#if l.email}<span class="text-muted-foreground">· {l.email}</span>{/if}
              {#if detailText(l.detail)}<span class="text-muted-foreground"
                  >· {detailText(l.detail)}</span
                >{/if}
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  </div>
</div>
