<script lang="ts">
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import DictationField from '$lib/voice/dictation-field.svelte'
  import type { TeamQuestionView } from '$lib/server/memory/team-questions/service'

  /**
   * Questions for me, on my dashboard (wishes f3fc516e, 3c1481b9): the team
   * questions asked of me that I have not answered yet (questions.list
   * for_me), each answerable right here — the answer posts to Memory ›
   * Questions' own action (questions.answer) — or opened there. Hidden when
   * none is open for me.
   */
  let { questions }: { questions: TeamQuestionView[] } = $props()

  const page = resolve('/m/memory/questions')
  let errors = $state<Record<string, string>>({})
  /** Each question's answer field, for its dictation control. */
  let answerEls = $state<Record<string, HTMLInputElement | null>>({})
</script>

{#if questions.length > 0}
  <section
    class="stage stage-white h-full items-stretch justify-start gap-3 p-5"
    data-testid="dashboard-questions"
  >
    <div class="hairline">
      <h2 class="text-[15px] leading-snug font-medium">Questions for you</h2>
      <p class="on-soft text-sm">Colleagues asked — answer here or open Questions</p>
    </div>
    <ul class="flex flex-col gap-3">
      {#each questions as q (q.id)}
        <li class="flex flex-col gap-2" data-testid="dashboard-question">
          <div class="min-w-0">
            <p class="text-sm font-medium">{q.text}</p>
            <p class="on-soft text-xs">From {q.author.name}</p>
          </div>
          <form
            method="POST"
            action="{page}?/answer"
            class="flex gap-1.5"
            data-testid="dashboard-question-answer"
            use:enhance={() =>
              async ({ result, update }) => {
                if (result.type === 'failure') {
                  const msg = (result.data as { error?: string } | undefined)?.error
                  errors = { ...errors, [q.id]: msg ?? 'The answer could not be saved.' }
                  return
                }
                errors = { ...errors, [q.id]: '' }
                await update()
              }}
          >
            <input type="hidden" name="question_id" value={q.id} />
            <label class="sr-only" for="dash-answer-{q.id}">Your answer</label>
            <DictationField field={answerEls[q.id] ?? null} kind="input" testid="dashboard-question-voice" class="min-w-0 flex-1">
              <input
                bind:this={answerEls[q.id]}
                id="dash-answer-{q.id}"
                name="text"
                required
                maxlength="4000"
                placeholder="Your answer"
                class="h-8 w-full min-w-0 rounded-full border bg-background py-0 pr-9 pl-3 text-sm"
              />
            </DictationField>
            <button
              type="submit"
              class="inline-flex h-8 shrink-0 items-center rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring"
              >Answer</button
            >
            <a
              href={page}
              class="inline-flex h-8 shrink-0 items-center rounded-full bg-muted px-3.5 text-sm font-medium outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="dashboard-question-open">Open</a
            >
          </form>
          {#if errors[q.id]}
            <ErrorNotice
              class="text-xs"
              error={errors[q.id]}
              attempted="Answering a team question from the dashboard"
            />
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
