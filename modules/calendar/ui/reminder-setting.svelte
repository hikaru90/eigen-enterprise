<script lang="ts">
  import type { ReminderMinutes } from '../types'
  import { enhance } from '$app/forms'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { REMINDER_CHOICES } from '../types'

  /**
   * The person's reminder setting (plan/calendar.md K3): a push to their
   * phone this many minutes before each of their events, or none. Saved with
   * ?/reminder (calendar.set_reminder).
   */
  let {
    minutes,
    error = null,
  }: {
    /** null = no reminders. */
    minutes: ReminderMinutes | null
    error?: ShownError | null
  } = $props()

  const label = (n: number) =>
    n === 0 ? m.calendar_reminder_at_start() : m.calendar_reminder_before({ minutes: n })
  const selectClass = 'border-input bg-background h-8 rounded-md border px-2 text-xs'
</script>

<form
  method="POST"
  action="?/reminder"
  class="grid gap-2"
  use:enhance={() =>
    async ({ update }) =>
      update({ reset: false })}
  data-testid="calendar-reminder"
>
  <label for="calendar-reminder-minutes" class="text-sm font-semibold"
    >{m.calendar_reminder_label()}</label
  >
  <div class="flex flex-wrap items-center gap-2">
    <select
      id="calendar-reminder-minutes"
      name="reminderMinutes"
      class={selectClass}
      value={minutes === null ? 'off' : String(minutes)}
    >
      {#each REMINDER_CHOICES as n (n)}<option value={String(n)}>{label(n)}</option>{/each}
      <option value="off">{m.calendar_reminder_off()}</option>
    </select>
    <Button type="submit" variant="outline" size="sm">{m.calendar_save()}</Button>
  </div>
  <p class="text-xs text-muted-foreground">{m.calendar_reminder_hint()}</p>
  {#if error}<ErrorNotice {...error} class="text-xs" />{/if}
</form>
