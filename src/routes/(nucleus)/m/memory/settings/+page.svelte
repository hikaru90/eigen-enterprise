<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { TIMEZONE_OFFSET_OPTIONS } from '$lib/i18n/timezone-offset'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  let saving = $state(false)

  let archivedOpen = $state(false)
  let deletingArchived = $state(false)
  let confirmation = $state('')
  let deletingAll = $state(false)
  /** The typed phrase must match exactly before the button arms (server checks again). */
  const allArmed = $derived(confirmation.trim() === data.deleteAllConfirmation)

  const field =
    'h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
</script>

<svelte:head><title>{docTitle('Settings', 'Memory')}</title></svelte:head>

<div class="w-full px-4 pt-8 pb-16 sm:px-8">
  <section aria-labelledby="settings-heading" data-testid="memory-settings">
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

  <section
    id="your-data"
    aria-labelledby="your-data-heading"
    class="mt-10 scroll-mt-6"
    data-testid="memory-your-data"
  >
    <h2 id="your-data-heading" class="text-[13px] font-medium">Your data</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      Your Memory is yours: take a copy, or delete it. Single thoughts, tasks and notes have their
      own Delete where they are listed.
    </p>

    <div class="mt-4 grid gap-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium">Download a copy</p>
          <p class="text-sm text-muted-foreground">
            Your thoughts, notes and graph as a .zip file.
          </p>
        </div>
        <Button href="/api/memory/export" variant="outline" size="sm" download>Download</Button>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div class="min-w-0">
          <p class="text-sm font-medium">Archived thoughts</p>
          <p class="text-sm text-muted-foreground" data-testid="memory-archived-count">
            {#if form && 'archivedDeleted' in form}
              Deleted {form.archivedDeleted} archived {form.archivedDeleted === 1
                ? 'thought'
                : 'thoughts'} for good.
            {:else if data.archivedCount === 0}
              None. Archived thoughts are hidden from your lists but still stored.
            {:else}
              {data.archivedCount} hidden from your lists but still stored — including any you deleted
              before Delete removed things for good.
            {/if}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={data.archivedCount === 0}
          onclick={() => (archivedOpen = true)}
          data-testid="memory-delete-archived"
        >
          Delete archived
        </Button>
      </div>

      <form
        method="POST"
        action="?/deleteAll"
        class="grid gap-3 border-t border-border pt-4"
        use:enhance={() => {
          deletingAll = true
          return async ({ update }) => {
            await update()
            deletingAll = false
            confirmation = ''
          }
        }}
        data-testid="memory-delete-all"
      >
        <div class="min-w-0">
          <p class="text-sm font-medium text-destructive">Delete everything in my Memory</p>
          <p class="text-sm text-muted-foreground">
            Every thought, task, project, note and capture you put in, what Memory learned about you
            in check-ins, and its graph and summaries — for good. Your chats with the assistant,
            your settings and API keys stay, and so does the company Roadmap. This can’t be undone.
          </p>
        </div>
        <div class="grid gap-1.5 sm:max-w-sm">
          <Label for="memory-delete-all-confirm">
            Type <span class="font-mono">{data.deleteAllConfirmation}</span> to confirm
          </Label>
          <Input
            id="memory-delete-all-confirm"
            name="confirmation"
            autocomplete="off"
            spellcheck={false}
            bind:value={confirmation}
          />
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="destructive" size="sm" disabled={!allArmed || deletingAll}>
            {deletingAll ? 'Deleting…' : 'Delete everything'}
          </Button>
          {#if form && 'deletedAll' in form && form.deletedAll}
            <p class="text-sm text-muted-foreground" role="status">
              Deleted {form.deletedAll.thoughtsDeleted} thoughts and tasks, {form.deletedAll
                .notesDeleted} notes and {form.deletedAll.entitiesDeleted} people, places and projects.
            </p>
          {:else if form && 'dataMessage' in form}
            <p class="text-sm text-destructive" role="alert">{form.dataMessage}</p>
          {/if}
        </div>
      </form>
    </div>
  </section>
</div>

<AlertDialog.Root
  open={archivedOpen}
  onOpenChange={(open) => {
    if (!deletingArchived) archivedOpen = open
  }}
>
  <AlertDialog.Content class="max-w-sm" data-testid="memory-delete-archived-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>Delete {data.archivedCount} archived thoughts for good?</AlertDialog.Title>
      <AlertDialog.Description>
        They are removed from your Memory with everything derived from them. This can’t be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deletingArchived}>Cancel</AlertDialog.Cancel>
      <form
        method="POST"
        action="?/deleteArchived"
        use:enhance={() => {
          deletingArchived = true
          return async ({ update }) => {
            await update()
            deletingArchived = false
            archivedOpen = false
          }
        }}
      >
        <Button type="submit" variant="destructive" disabled={deletingArchived}>
          {deletingArchived ? 'Deleting…' : 'Delete'}
        </Button>
      </form>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
