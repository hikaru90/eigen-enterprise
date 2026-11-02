<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { TIMEZONE_OFFSET_OPTIONS } from '$lib/i18n/timezone-offset'
  import { MEMORY_TABS } from '$lib/memory/memory-surface-nav'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  let saving = $state(false)

  const blurbs: Record<string, string> = {
    tasks: 'What is due today, overdue and coming up.',
    projects: 'Projects and their next actions.',
    notes: 'Everything written down.',
    capture: 'Write or say a thought; Memory files it.',
  }
  const sections = MEMORY_TABS.filter((t) => t.id !== 'overview')
  const field =
    'h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
</script>

<svelte:head><title>{docTitle('Memory')}</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 pt-8 pb-16 sm:px-8">
  <section aria-labelledby="sections-heading">
    <h2 id="sections-heading" class="mb-2 text-[13px] font-medium">Sections</h2>
    <ul class="grid gap-3 sm:grid-cols-2">
      {#each sections as s (s.id)}
        <li>
          <a
            href={resolve(s.href)}
            class="group flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">{s.label}</span>
              <span class="block truncate text-xs text-muted-foreground">{blurbs[s.id]}</span>
            </span>
            <ArrowUpRight
              class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
              aria-hidden="true"
            />
          </a>
        </li>
      {/each}
    </ul>
  </section>

  <section class="mt-10" aria-labelledby="settings-heading" data-testid="memory-settings">
    <h2 id="settings-heading" class="text-[13px] font-medium">Settings</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      Reminders for your tasks and a daily summary, sent as push notifications.
    </p>
    <form
      method="POST"
      action="?/settings"
      class="mt-4 grid gap-5 rounded-lg border border-border bg-card p-4 sm:p-5"
      use:enhance={() => {
        saving = true
        return async ({ update }) => {
          await update({ reset: false })
          saving = false
        }
      }}
    >
      <div class="grid gap-1.5 sm:max-w-xs">
        <Label for="memory-tz">Time zone</Label>
        <select
          id="memory-tz"
          name="timezoneOffsetMinutes"
          class={field}
          value={String(data.settings.timezoneOffsetMinutes)}
        >
          {#each TIMEZONE_OFFSET_OPTIONS as opt (opt.value)}
            <option value={String(opt.value)}>{opt.label}</option>
          {/each}
        </select>
      </div>

      <div class="flex flex-wrap items-end gap-x-6 gap-y-3">
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="eventNotificationsEnabled"
            class="size-4 accent-primary"
            checked={data.settings.eventNotificationsEnabled}
          />
          Remind me before tasks and events
        </label>
        <div class="grid gap-1.5">
          <Label for="memory-lead">Minutes before</Label>
          <Input
            id="memory-lead"
            name="eventReminderLeadMinutes"
            type="number"
            min="1"
            class="w-28"
            value={String(data.settings.eventReminderLeadMinutes)}
          />
        </div>
      </div>

      <div class="flex flex-wrap items-end gap-x-6 gap-y-3">
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="dailySummaryEnabled"
            class="size-4 accent-primary"
            checked={data.settings.dailySummaryEnabled}
          />
          Send me a daily summary
        </label>
        <div class="grid gap-1.5">
          <Label for="memory-summary-time">At</Label>
          <Input
            id="memory-summary-time"
            name="dailySummaryTimeLocal"
            type="time"
            class="w-32"
            value={data.settings.dailySummaryTimeLocal}
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        {#if form?.message}
          <p
            class="text-sm {form && 'saved' in form ? 'text-muted-foreground' : 'text-destructive'}"
            role="status"
            data-testid="memory-settings-message"
          >
            {form.message}
          </p>
        {/if}
      </div>
    </form>
  </section>
</div>
