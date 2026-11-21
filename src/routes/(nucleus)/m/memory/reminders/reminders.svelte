<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit'
  import { enhance } from '$app/forms'
  import { dueLine, nextLine, rhythmLine, WEEKDAY_LABELS } from '$lib/memory/reminder-format'
  import type { ReminderView } from '$lib/server/memory/reminders/service'
  import DictationField from '$lib/voice/dictation-field.svelte'

  /**
   * Memory › Reminders: the person's own recurring reminders (Contribute
   * 2c414719). A new one takes a title, an optional note, the weekdays and a
   * time — in the person's time zone (Settings). Each one can be changed,
   * paused, resumed or deleted; a due one is ticked off or snoozed here and
   * under Needs you on the dashboard. Every form posts to this page's actions
   * (the reminders.* registry tools); `formMessage` is the refusal for one
   * reminder ('new' = the create form), if any.
   */
  let {
    reminders,
    timeZone,
    formMessage = null,
  }: {
    reminders: ReminderView[]
    timeZone: string
    formMessage?: { reminderId: string; message: string } | null
  } = $props()

  const weekdays = Object.entries(WEEKDAY_LABELS) as Array<[keyof typeof WEEKDAY_LABELS, string]>
  const snoozeOptions = [
    { minutes: 60, label: '1 hour' },
    { minutes: 180, label: '3 hours' },
    { minutes: 1440, label: '1 day' },
    { minutes: 10080, label: '1 week' },
  ]

  /** The reminder whose edit form is open (view state only). */
  let editing = $state<string | null>(null)
  const closeOnSuccess: SubmitFunction = () => async ({ result, update }) => {
    await update()
    if (result.type === 'success') editing = null
  }

  const pill =
    'inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const ink = `${pill} bg-primary text-primary-foreground hover:opacity-85`
  const soft = `${pill} bg-muted text-foreground hover:bg-muted/70`
  const field =
    'h-8 min-w-0 rounded-full border border-input bg-background px-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
  /** A free-text field with the dictation mic docked inside it. */
  const textField = `${field} w-full pr-9`
  /** The new form's fields, and the open edit form's (one at a time), for dictation. */
  let newTitleEl = $state<HTMLInputElement | null>(null)
  let newNoteEl = $state<HTMLInputElement | null>(null)
  let editTitleEl = $state<HTMLInputElement | null>(null)
  let editNoteEl = $state<HTMLInputElement | null>(null)
</script>

{#snippet dayPicker(selected: readonly string[], prefix: string)}
  <fieldset class="flex flex-wrap gap-1.5">
    <legend class="sr-only">Weekdays</legend>
    {#each weekdays as [code, label] (code)}
      <label class="cursor-pointer">
        <input type="checkbox" name="weekdays" value={code} checked={selected.includes(code)} class="peer sr-only" data-testid="{prefix}-day-{code}" />
        <span
          class="inline-flex h-8 min-w-11 items-center justify-center rounded-full bg-muted px-2.5 text-sm text-muted-foreground peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
          >{label}</span
        >
      </label>
    {/each}
  </fieldset>
{/snippet}

{#snippet message(id: string)}
  {#if formMessage?.reminderId === id}
    <p class="text-sm text-destructive" role="alert">{formMessage.message}</p>
  {/if}
{/snippet}

<div class="flex min-w-0 flex-col gap-6" data-testid="reminders">
  <form method="POST" action="?/create" use:enhance class="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4" data-testid="reminder-new">
    <div class="flex min-w-0 flex-col gap-0.5">
      <h2 class="text-[15px] leading-snug font-medium">New reminder</h2>
      <p class="text-sm text-muted-foreground">Comes back every week and waits under Needs you until you tick it off. Times are in {timeZone}.</p>
    </div>
    <label class="sr-only" for="reminder-title">Title</label>
    <DictationField field={newTitleEl} kind="input" testid="reminder-title-voice">
      <input bind:this={newTitleEl} id="reminder-title" name="title" required maxlength="200" placeholder="Prepare, check or send LinkedIn posts" class={textField} />
    </DictationField>
    <label class="sr-only" for="reminder-note">Note</label>
    <DictationField field={newNoteEl} kind="input" testid="reminder-note-voice">
      <input bind:this={newNoteEl} id="reminder-note" name="note" maxlength="2000" placeholder="Note (optional)" class={textField} />
    </DictationField>
    <div class="flex min-w-0 flex-wrap items-center gap-3">
      {@render dayPicker([], 'new')}
      <label class="sr-only" for="reminder-time">Time</label>
      <input id="reminder-time" name="time" type="time" required value="09:00" class="{field} w-28" />
      <button type="submit" class={ink} data-testid="reminder-create">Add reminder</button>
    </div>
    {@render message('new')}
  </form>

  {#if reminders.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="reminders-empty">No reminders yet. You can also ask the assistant: “Remind me every Monday and Thursday at 9 to prepare my LinkedIn posts.”</p>
  {:else}
    <ul class="flex flex-col gap-2" aria-label="Your reminders">
      {#each reminders as r (r.id)}
        <li class="flex min-w-0 flex-col gap-2 rounded-2xl bg-card p-4" data-testid="reminder" data-reminder-id={r.id} id="reminder-{r.id}">
          {#if editing === r.id}
            <form method="POST" action="?/update" use:enhance={closeOnSuccess} class="flex min-w-0 flex-col gap-3" data-testid="reminder-edit">
              <input type="hidden" name="reminder_id" value={r.id} />
              <label class="sr-only" for="title-{r.id}">Title</label>
              <DictationField field={editTitleEl} kind="input" testid="title-{r.id}-voice">
                <input bind:this={editTitleEl} id="title-{r.id}" name="title" required maxlength="200" value={r.title} class={textField} />
              </DictationField>
              <label class="sr-only" for="note-{r.id}">Note</label>
              <DictationField field={editNoteEl} kind="input" testid="note-{r.id}-voice">
                <input bind:this={editNoteEl} id="note-{r.id}" name="note" maxlength="2000" value={r.note} placeholder="Note (optional)" class={textField} />
              </DictationField>
              <div class="flex min-w-0 flex-wrap items-center gap-3">
                {@render dayPicker(r.weekdays, `edit-${r.id}`)}
                <label class="sr-only" for="time-{r.id}">Time</label>
                <input id="time-{r.id}" name="time" type="time" required value={r.time} class="{field} w-28" />
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <button type="submit" class={ink} data-testid="reminder-save">Save</button>
                <button type="button" class={soft} onclick={() => (editing = null)}>Cancel</button>
              </div>
            </form>
          {:else}
            <div class="flex min-w-0 items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-[15px] leading-snug font-medium wrap-break-word {r.status === 'paused' ? 'text-muted-foreground' : ''}">{r.title}</h3>
                <p class="text-sm text-muted-foreground" data-testid="reminder-rhythm">{rhythmLine(r)} · {nextLine(r)}</p>
                {#if r.note}
                  <p class="text-sm whitespace-pre-line wrap-break-word">{r.note}</p>
                {/if}
              </div>
              <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <button type="button" class={soft} onclick={() => (editing = r.id)} data-testid="reminder-edit-open">Edit</button>
                <form method="POST" action={r.status === 'paused' ? '?/resume' : '?/pause'} use:enhance>
                  <input type="hidden" name="reminder_id" value={r.id} />
                  <button type="submit" class={soft} data-testid="reminder-{r.status === 'paused' ? 'resume' : 'pause'}">{r.status === 'paused' ? 'Resume' : 'Pause'}</button>
                </form>
                <form method="POST" action="?/delete" use:enhance>
                  <input type="hidden" name="reminder_id" value={r.id} />
                  <button type="submit" class="{pill} text-muted-foreground hover:bg-muted/70 hover:text-foreground" data-testid="reminder-delete">Delete</button>
                </form>
              </div>
            </div>
            {#if r.due}
              <div class="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 p-2 pl-3" data-testid="reminder-due">
                <p class="text-sm"><span class="mr-1.5 inline-block size-2 rounded-full bg-coral align-middle" aria-hidden="true"></span>{dueLine(r)}</p>
                <div class="flex flex-wrap items-center gap-1.5">
                  <form method="POST" action="?/snooze" use:enhance class="flex items-center gap-1.5">
                    <input type="hidden" name="reminder_id" value={r.id} />
                    <label class="sr-only" for="snooze-{r.id}">Snooze for</label>
                    <select id="snooze-{r.id}" name="minutes" class="{field} pr-2">
                      {#each snoozeOptions as o (o.minutes)}<option value={o.minutes}>{o.label}</option>{/each}
                    </select>
                    <button type="submit" class={soft} data-testid="reminder-snooze">Snooze</button>
                  </form>
                  {#if r.due.count > 1}
                    <form method="POST" action="?/complete" use:enhance>
                      <input type="hidden" name="reminder_id" value={r.id} />
                      <input type="hidden" name="all" value="1" />
                      <button type="submit" class={soft} data-testid="reminder-done-all">All {r.due.count} done</button>
                    </form>
                  {/if}
                  <form method="POST" action="?/complete" use:enhance>
                    <input type="hidden" name="reminder_id" value={r.id} />
                    <button type="submit" class={ink} data-testid="reminder-done">Done</button>
                  </form>
                </div>
              </div>
            {/if}
          {/if}
          {@render message(r.id)}
        </li>
      {/each}
    </ul>
  {/if}
</div>
