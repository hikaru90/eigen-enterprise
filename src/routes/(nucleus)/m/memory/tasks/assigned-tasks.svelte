<script lang="ts">
  import { enhance } from '$app/forms'
  import { metaLine, updateLine } from '$lib/memory/assigned-task-format'
  import type { AssignedTaskView, TaskLists } from '$lib/server/memory/assigned-tasks/service'
  import DictationField from '$lib/voice/dictation-field.svelte'

  /**
   * Memory › Tasks: the tasks assigned between members — to this person, and
   * by them. Not their private Memory: a company-level record the two people
   * share (title, context, due day, comments). The assignee marks a task done;
   * either side comments; "Got it" acknowledges what is new (the assigner's
   * feedback when the assignee completed or commented). Each form posts to this
   * page's actions; `formMessage` is the refusal for one task, if any.
   */
  let {
    assigned,
    action = '',
    formMessage = null,
  }: {
    assigned: TaskLists
    /** Where the forms post: '' on the tasks page itself. */
    action?: string
    formMessage?: { taskId: string; message: string } | null
  } = $props()

  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const groups = $derived(
    [
      { id: 'to-me', label: 'Assigned to you', tasks: assigned.assignedToMe },
      { id: 'by-me', label: 'Assigned by you', tasks: assigned.assignedByMe },
    ].filter((g) => g.tasks.length > 0),
  )

  const pill =
    'inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  /** Each task's comment field, for dictation. */
  const commentEls = $state<Record<string, HTMLInputElement>>({})
</script>

{#snippet card(task: AssignedTaskView)}
  <li class="flex min-w-0 flex-col gap-2 rounded-2xl bg-card p-4" data-testid="assigned-task" data-task-id={task.id} id="assigned-{task.id}">
    <div class="flex min-w-0 items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-[15px] leading-snug font-medium wrap-break-word {task.status === 'done' ? 'text-muted-foreground line-through' : ''}">{task.title}</h3>
        <p class="text-sm text-muted-foreground" data-testid="assigned-task-meta">{metaLine(task)}</p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        {#if task.update}
          <form method="POST" action="{action}?/seen" use:enhance>
            <input type="hidden" name="task_id" value={task.id} />
            <button type="submit" class="{pill} bg-muted text-foreground hover:bg-muted/70" data-testid="assigned-task-seen">Got it</button>
          </form>
        {/if}
        {#if task.role === 'assignee' && task.status === 'open'}
          <form method="POST" action="{action}?/complete" use:enhance>
            <input type="hidden" name="task_id" value={task.id} />
            <button type="submit" class="{pill} bg-primary text-primary-foreground hover:opacity-85" data-testid="assigned-task-done">Done</button>
          </form>
        {/if}
      </div>
    </div>
    {#if task.update}
      <p class="text-sm" data-testid="assigned-task-update"><span class="mr-1.5 inline-block size-2 rounded-full bg-coral align-middle" aria-hidden="true"></span>{updateLine(task)}</p>
    {/if}
    {#if task.context}
      <p class="text-sm whitespace-pre-line wrap-break-word" data-testid="assigned-task-context">{task.context}</p>
    {/if}
    {#if task.comments.length > 0}
      <ol class="flex flex-col gap-1.5 border-l border-border pl-3" aria-label="Comments">
        {#each task.comments as comment (comment.id)}
          <li class="text-sm wrap-break-word" data-testid="assigned-task-comment">
            <span class="font-medium">{comment.author.name}</span>
            <time class="text-muted-foreground" datetime={comment.at}>{when.format(new Date(comment.at))}</time>
            <span class="block whitespace-pre-line">{comment.body}</span>
          </li>
        {/each}
      </ol>
    {/if}
    <form method="POST" action="{action}?/comment" use:enhance class="flex min-w-0 items-center gap-1.5">
      <input type="hidden" name="task_id" value={task.id} />
      <label class="sr-only" for="comment-{task.id}">Comment on {task.title}</label>
      <DictationField field={commentEls[task.id] ?? null} kind="input" testid="comment-{task.id}-voice" class="flex-1">
        <input
          bind:this={commentEls[task.id]}
          id="comment-{task.id}"
          name="body"
          required
          maxlength="4000"
          placeholder="Add a comment"
          class="h-8 w-full min-w-0 rounded-full border border-input bg-background pr-9 pl-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </DictationField>
      <button type="submit" class="{pill} bg-muted text-foreground hover:bg-muted/70">Comment</button>
    </form>
    {#if formMessage?.taskId === task.id}
      <p class="text-sm text-destructive" role="alert">{formMessage.message}</p>
    {/if}
  </li>
{/snippet}

{#if groups.length > 0}
  <section id="assigned" class="flex min-w-0 scroll-mt-6 flex-col gap-4" data-testid="assigned-tasks">
    {#each groups as group (group.id)}
      <div class="flex min-w-0 flex-col gap-2" data-testid="assigned-tasks-{group.id}">
        <h2 class="text-sm font-medium text-muted-foreground">{group.label}</h2>
        <ul class="flex flex-col gap-2">
          {#each group.tasks as task (task.id)}
            {@render card(task)}
          {/each}
        </ul>
      </div>
    {/each}
  </section>
{/if}
