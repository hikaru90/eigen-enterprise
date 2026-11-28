<script lang="ts">
  import { enterSends } from '$lib/components/keys/enter-sends'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import Textarea from '$lib/components/ui/textarea/textarea.svelte'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import type { TeamQuestionView } from '$lib/server/memory/team-questions/service'

  /**
   * Memory › Questions (Contribute 057cd4d5): short questions for colleagues —
   * the whole company or chosen groups and people — with free tags, answered
   * inline. One card per question: the one-line question, who asked whom, its
   * tags, the answers and (while open) an answer field; the asker closes it.
   * Filters are links (status, "open for me", one tag), so a filtered view is
   * a URL. Every form posts to this page's actions (the questions.* registry
   * tools); `formError` is the refusal for one question ('new' = the ask form).
   */
  type Filter = { tag: string | null; status: 'open' | 'closed' | 'all'; forMe: boolean }
  let {
    questions,
    tags,
    audience,
    filter,
    formError = null,
  }: {
    questions: TeamQuestionView[]
    tags: Array<{ tag: string; count: number }>
    audience: {
      groups: Array<{ id: string; name: string }>
      people: Array<{ id: string; name: string }>
    }
    filter: Filter
    formError?: ({ questionId: string } & ShownError) | null
  } = $props()

  /** The ask form's audience choice and tag field (view state only). */
  let askOf = $state<'company' | 'chosen'>('company')
  let tagText = $state('')

  function addTag(tag: string) {
    const current = tagText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (!current.includes(tag)) tagText = [...current, tag].join(', ')
  }

  const audienceOptions: Array<{ id: 'company' | 'chosen'; label: string }> = [
    { id: 'company', label: m.questions_audience_company() },
    { id: 'chosen', label: m.questions_audience_chosen() },
  ]
  const pickSections = $derived([
    { key: 'group_ids', label: m.questions_groups(), items: audience.groups },
    { key: 'person_ids', label: m.questions_people(), items: audience.people },
  ])

  /** The query string of a filtered view ('' = the default: open questions, any tag). */
  function queryOf(next: Partial<Filter>): string {
    const f = { ...filter, ...next }
    const parts: string[] = []
    if (f.forMe) parts.push('for=me')
    else if (f.status !== 'open') parts.push(`status=${f.status}`)
    if (f.tag) parts.push(`tag=${encodeURIComponent(f.tag)}`)
    return parts.length ? `?${parts.join('&')}` : ''
  }
  const statusLinks = $derived([
    {
      id: 'for-me',
      label: m.questions_filter_for_me(),
      query: queryOf({ forMe: true, status: 'open' }),
      on: filter.forMe,
    },
    {
      id: 'open',
      label: m.questions_filter_open(),
      query: queryOf({ forMe: false, status: 'open' }),
      on: !filter.forMe && filter.status === 'open',
    },
    {
      id: 'closed',
      label: m.questions_filter_closed(),
      query: queryOf({ forMe: false, status: 'closed' }),
      on: !filter.forMe && filter.status === 'closed',
    },
    {
      id: 'all',
      label: m.questions_filter_all(),
      query: queryOf({ forMe: false, status: 'all' }),
      on: !filter.forMe && filter.status === 'all',
    },
  ])

  const audienceLine = (q: TeamQuestionView) =>
    q.audience.kind === 'company'
      ? m.questions_to_company()
      : m.questions_to({
          audience: [
            ...q.audience.groups.map((g) => g.name),
            ...q.audience.people.map((p) => p.name),
          ].join(', '),
        })
  const answerCount = (n: number) =>
    n === 1 ? m.questions_one_answer() : m.questions_many_answers({ count: n })
  /** "From Ony to Sales, Sam · 2 answers · You answered · Closed" */
  const metaLine = (q: TeamQuestionView) =>
    [
      `${q.mine ? m.questions_from_you() : m.questions_from({ author: q.author.name })} ${audienceLine(q)}`,
      answerCount(q.answers.length),
      ...(q.answeredByMe ? [m.questions_answered_by_you()] : []),
      ...(q.status === 'closed' ? [m.questions_closed()] : []),
    ].join(' · ')

  const pill =
    'inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const ink = `${pill} bg-primary text-primary-foreground hover:opacity-85`
  const soft = `${pill} bg-muted text-foreground hover:bg-muted/70`
  const chip =
    'inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs text-muted-foreground'
  const filterChip = (on: boolean) =>
    `inline-flex h-7 items-center rounded-full px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`
</script>

{#snippet message(id: string)}
  {#if formError?.questionId === id}
    <ErrorNotice
      error={formError.error}
      agent={formError.agent}
      attempted="Team questions on /m/memory/questions"
    />
  {/if}
{/snippet}

<div class="flex min-w-0 flex-col gap-6" data-testid="questions">
  <form
    method="POST"
    action="?/ask"
    use:enhance
    class="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4"
    data-testid="question-new"
  >
    <div class="flex min-w-0 flex-col gap-0.5">
      <h2 class="text-[15px] leading-snug font-medium">{m.questions_ask_title()}</h2>
      <p class="text-sm text-muted-foreground">{m.questions_ask_hint()}</p>
    </div>
    <label class="sr-only" for="question-text">{m.questions_text_label()}</label>
    <Textarea
      id="question-text"
      name="text"
      required
      maxlength={500}
      rows={1}
      class="min-h-9"
      placeholder={m.questions_text_placeholder()}
      onkeydown={enterSends()}
      data-testid="question-text"
    />
    <label class="sr-only" for="question-tags">{m.questions_tags_label()}</label>
    <Input
      id="question-tags"
      name="tags"
      bind:value={tagText}
      dictation={false}
      placeholder={m.questions_tags_placeholder()}
      data-testid="question-tags"
    />
    {#if tags.length > 0}
      <div class="flex flex-wrap items-center gap-1.5" data-testid="question-tag-suggestions">
        <span class="text-xs text-muted-foreground">{m.questions_tags_in_use()}:</span>
        {#each tags as t (t.tag)}
          <button type="button" class="{chip} hover:text-foreground" onclick={() => addTag(t.tag)}
            >#{t.tag}</button
          >
        {/each}
      </div>
    {/if}
    <fieldset class="flex min-w-0 flex-col gap-2">
      <legend class="sr-only">{m.questions_audience_label()}</legend>
      <div class="flex flex-wrap gap-1.5">
        {#each audienceOptions as o (o.id)}
          <label class="cursor-pointer">
            <input
              type="radio"
              name="audience"
              value={o.id}
              checked={askOf === o.id}
              onchange={() => (askOf = o.id)}
              class="peer sr-only"
              data-testid="question-audience-{o.id}"
            />
            <span
              class="inline-flex h-8 items-center rounded-full bg-muted px-3.5 text-sm text-muted-foreground peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
              >{o.label}</span
            >
          </label>
        {/each}
      </div>
      {#if askOf === 'chosen'}
        <div class="flex min-w-0 flex-col gap-2" data-testid="question-audience-picker">
          {#each pickSections as section (section.key)}
            {#if section.items.length > 0}
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="w-16 text-xs text-muted-foreground">{section.label}</span>
                {#each section.items as item (item.id)}
                  <label class="cursor-pointer">
                    <input
                      type="checkbox"
                      name={section.key}
                      value={item.id}
                      class="peer sr-only"
                      data-testid="question-pick-{item.id}"
                    />
                    <span
                      class="inline-flex h-7 items-center rounded-full bg-muted px-3 text-sm text-muted-foreground peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
                      >{item.name}</span
                    >
                  </label>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </fieldset>
    <div>
      <button type="submit" class={ink} data-testid="question-ask"
        >{m.questions_ask_submit()}</button
      >
    </div>
    {@render message('new')}
  </form>

  <!-- eslint-disable svelte/no-navigation-without-resolve -- the filter links are resolve() of this page plus their query string -->
  <nav class="flex min-w-0 flex-col gap-2" aria-label={m.questions_filter_label()}>
    <div class="flex flex-wrap gap-1.5">
      {#each statusLinks as l (l.id)}
        <a
          href={`${resolve('/m/memory/questions')}${l.query}`}
          class={filterChip(l.on)}
          aria-current={l.on ? 'page' : undefined}
          data-testid="questions-filter-{l.id}">{l.label}</a
        >
      {/each}
    </div>
    {#if tags.length > 0}
      <div
        class="flex flex-wrap gap-1.5"
        aria-label={m.questions_filter_tags_label()}
        data-testid="questions-tag-filter"
      >
        <a
          href={`${resolve('/m/memory/questions')}${queryOf({ tag: null })}`}
          class={filterChip(!filter.tag)}
          aria-current={!filter.tag ? 'page' : undefined}>{m.questions_filter_any_tag()}</a
        >
        {#each tags as t (t.tag)}
          <a
            href={`${resolve('/m/memory/questions')}${queryOf({ tag: t.tag })}`}
            class={filterChip(filter.tag === t.tag)}
            aria-current={filter.tag === t.tag ? 'page' : undefined}
            data-testid="questions-tag-{t.tag}">#{t.tag}</a
          >
        {/each}
      </div>
    {/if}
  </nav>
  <!-- eslint-enable svelte/no-navigation-without-resolve -->

  {#if questions.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="questions-empty">
      {filter.forMe ? m.questions_empty_for_me() : m.questions_empty()}
    </p>
  {:else}
    <ul class="flex flex-col gap-2" aria-label={m.questions_list_label()}>
      {#each questions as q (q.id)}
        <li
          class="flex min-w-0 flex-col gap-2 rounded-2xl bg-card p-4"
          data-testid="question"
          data-question-id={q.id}
          id="question-{q.id}"
        >
          <div class="flex min-w-0 items-start justify-between gap-3">
            <div class="min-w-0">
              <h3
                class="text-[15px] leading-snug font-medium wrap-break-word {q.status === 'closed'
                  ? 'text-muted-foreground'
                  : ''}"
                data-testid="question-title"
              >
                {#if q.forMe}<span
                    class="mr-1.5 inline-block size-2 rounded-full bg-coral align-middle"
                    aria-hidden="true"
                  ></span>{/if}{q.text}
              </h3>
              <p class="text-sm text-muted-foreground" data-testid="question-meta">
                {metaLine(q)}
              </p>
              {#if q.tags.length > 0}
                <div class="mt-1.5 flex flex-wrap gap-1" data-testid="question-tags-shown">
                  {#each q.tags as tag (tag)}<span class={chip}>#{tag}</span>{/each}
                </div>
              {/if}
            </div>
            {#if q.mine && q.status === 'open'}
              <form method="POST" action="?/close" use:enhance>
                <input type="hidden" name="question_id" value={q.id} />
                <button
                  type="submit"
                  class="{pill} text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                  data-testid="question-close">{m.questions_close()}</button
                >
              </form>
            {/if}
          </div>
          {#if q.answers.length > 0}
            <ul
              class="flex flex-col gap-1.5 border-l-2 border-muted pl-3"
              data-testid="question-answers"
            >
              {#each q.answers as a (a.id)}
                <li class="text-sm wrap-break-word">
                  <span class="font-medium">{a.author.name}</span>
                  <span class="whitespace-pre-line">{a.text}</span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if q.status === 'open'}
            <form
              method="POST"
              action="?/answer"
              use:enhance
              class="flex min-w-0 items-start gap-1.5"
              data-testid="question-answer-form"
            >
              <input type="hidden" name="question_id" value={q.id} />
              <label class="sr-only" for="answer-{q.id}">{m.questions_answer_label()}</label>
              <Input
                id="answer-{q.id}"
                name="text"
                required
                maxlength={4000}
                placeholder={m.questions_answer_placeholder()}
                containerClass="flex-1"
                class="h-8"
                data-testid="question-answer-text"
              />
              <button type="submit" class={soft} data-testid="question-answer"
                >{m.questions_answer_submit()}</button
              >
            </form>
          {/if}
          {@render message(q.id)}
        </li>
      {/each}
    </ul>
  {/if}
</div>
