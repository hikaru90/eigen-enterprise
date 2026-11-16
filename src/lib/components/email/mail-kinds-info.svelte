<script lang="ts">
  import InfoIcon from '@lucide/svelte/icons/info'
  import * as Popover from '$lib/components/ui/popover'
  import { MAIL_KIND_ORDER, MAIL_KINDS, type MailKind } from './mail-kinds'

  /**
   * "What is the difference?" — the three kinds of mail and their rules, behind one info button (collapsed by
   * default: people dislike permanently visible info text). `current` marks the kind the open tab shows.
   */
  let { current = null }: { current?: MailKind | null } = $props()
</script>

<Popover.Root>
  <Popover.Trigger
    class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
    aria-label="Personal, transactional, marketing: what is the difference?"
    data-testid="mail-kinds-trigger"
  >
    <InfoIcon class="size-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
    <span>Kinds of mail</span>
  </Popover.Trigger>
  <Popover.Content
    align="end"
    side="bottom"
    sideOffset={6}
    class="max-h-[min(36rem,calc(100vh-6rem))] w-[min(28rem,calc(100vw-1.5rem))] gap-3 overflow-y-auto p-4 text-sm"
    data-testid="mail-kinds-panel"
  >
    <p class="font-medium">Three kinds of mail, three sets of rules</p>
    {#each MAIL_KIND_ORDER as kind (kind)}
      <section
        class="rounded-md border p-3 {current === kind ? 'border-foreground/25 bg-muted/50' : 'border-border'}"
        aria-current={current === kind ? 'true' : undefined}
        aria-labelledby={`mail-kind-${kind}-title`}
        data-testid={`mail-kind-${kind}`}
      >
        <p id={`mail-kind-${kind}-title`} class="font-medium">{MAIL_KINDS[kind].label}</p>
        <p class="mt-0.5 text-muted-foreground">{MAIL_KINDS[kind].line}</p>
        <ul class="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          {#each MAIL_KINDS[kind].rules as rule (rule)}<li>{rule}</li>{/each}
        </ul>
      </section>
    {/each}
    <p class="text-xs text-muted-foreground">A plain-words summary, not legal advice.</p>
  </Popover.Content>
</Popover.Root>
