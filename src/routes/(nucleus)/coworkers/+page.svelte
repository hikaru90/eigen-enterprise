<script lang="ts">
  import type { PageProps } from './$types'
  import Plus from '@lucide/svelte/icons/plus'
  import X from '@lucide/svelte/icons/x'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import ActionFeedback from '$lib/coworkers/action-feedback.svelte'
  import { feedbackFor } from '$lib/coworkers/action-result'
  import CoworkerCard from '$lib/coworkers/coworker-card.svelte'
  import CoworkerCreateForm from '$lib/coworkers/coworker-create-form.svelte'
  import OrgDiagram from '$lib/coworkers/org-diagram.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'

  /**
   * Top-level AI Co-workers page (`/coworkers`): visual organization diagram
   * for everyone, plus management list and "+ New co-worker" modal for owners
   * and admins.
   */
  let { data, form }: PageProps = $props()

  let activeTab = $state<'org' | 'manage'>('org')
  let createOpen = $state(false)

  const createFeedback = $derived(feedbackFor(form, 'create'))
</script>

<svelte:head>
  <title>{docTitle(m.coworkers_nav_title())}</title>
</svelte:head>

<PageFrame testid="coworkers-page">
  <div class="space-y-6">
    <PageHeader
      title={m.coworkers_nav_title()}
      part="coworkers"
      description={data.me.canManage ? m.org_page_intro_admin() : m.org_page_intro_member()}
    >
      {#snippet actions()}
        {#if data.me.canManage}
          <Button
            type="button"
            onclick={() => (createOpen = true)}
            data-testid="coworkers-add-button"
          >
            <Plus class="size-4" aria-hidden="true" />
            {m.coworkers_new_button()}
          </Button>
        {/if}
      {/snippet}
    </PageHeader>

    {#if data.me.canManage}
      <div
        class="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full bg-muted p-1"
        role="tablist"
        aria-label={m.coworkers_nav_title()}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'org'}
          data-testid="coworkers-tab-org"
          onclick={() => (activeTab = 'org')}
          class={[
            'shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeTab === 'org'
              ? 'bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]'
              : 'text-muted-foreground hover:text-foreground',
          ]}
        >
          {m.coworkers_tab_org_diagram()}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'manage'}
          data-testid="coworkers-tab-manage"
          onclick={() => (activeTab = 'manage')}
          class={[
            'shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeTab === 'manage'
              ? 'bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]'
              : 'text-muted-foreground hover:text-foreground',
          ]}
        >
          {m.coworkers_tab_coworkers()}
        </button>
      </div>
    {/if}

    {#if !createOpen && createFeedback?.kind === 'done'}
      <ActionFeedback
        feedback={createFeedback}
        done={m.coworkers_created()}
        testid="coworker-create-page-feedback"
      />
    {/if}

    {#if data.me.canManage && activeTab === 'manage'}
      <section aria-label={m.coworkers_list_heading()} data-testid="coworkers-list">
        {#if data.coworkers.length === 0}
          <p class="text-sm text-muted-foreground" data-testid="coworkers-empty">
            {m.coworkers_empty_modal()}
          </p>
        {:else}
          <ul class="space-y-2">
            {#each data.coworkers as c (c.id)}
              <CoworkerCard
                coworker={c}
                models={data.models}
                seats={data.seats}
                {form}
                rhythms={data.rhythms[c.id] ?? { rhythms: [], targets: [] }}
                timeZone={data.timeZone ?? 'UTC'}
              />
            {/each}
          </ul>
        {/if}
      </section>
    {:else}
      <OrgDiagram people={data.people} me={data.me} {form} />
    {/if}
  </div>
</PageFrame>

{#if data.me.canManage}
  <Dialog.Root bind:open={createOpen}>
    <Dialog.Content
      class="max-h-[90dvh] max-w-2xl overflow-y-auto"
      data-testid="coworkers-create-dialog"
    >
      <Dialog.Header class="flex flex-row items-start justify-between gap-4">
        <div class="space-y-1">
          <Dialog.Title>{m.coworkers_new_heading()}</Dialog.Title>
          <Dialog.Description>{m.coworkers_page_intro()}</Dialog.Description>
        </div>
        <Dialog.Close
          class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={m.coworkers_cancel()}
        >
          <X class="size-4" aria-hidden="true" />
        </Dialog.Close>
      </Dialog.Header>
      <CoworkerCreateForm
        templates={data.templates}
        models={data.models}
        seats={data.seats}
        feedback={createFeedback}
        oncreated={() => (createOpen = false)}
      />
    </Dialog.Content>
  </Dialog.Root>
{/if}
