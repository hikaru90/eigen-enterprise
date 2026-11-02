<script lang="ts">
  import { resolve } from '$app/paths'
  import { pickerQuery, type PickerCard, type PreviewMode } from './types'

  /** Full-width grid of precompiled preview cards (plan/phase-brand-picker.md P1). */
  let { cards, mode }: { cards: PickerCard[]; mode: PreviewMode } = $props()
</script>

<ul class="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
  {#each cards as card (card.id)}
    <li>
      <a
        data-picker-card={card.id}
        href={resolve(`/brand${pickerQuery(card.id)}` as '/brand')}
        class="group border-border bg-card text-card-foreground focus-visible:ring-ring flex h-full flex-col overflow-hidden rounded-xl border transition hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      >
        <img
          src={card.preview[mode]}
          alt={`${card.name} preview (${mode})`}
          class="aspect-[8/5] w-full object-cover"
          loading="lazy"
          width="480"
          height="300"
        />
        <span class="flex flex-col gap-1 px-4 py-3">
          <span class="font-medium">{card.name}</span>
          <span class="text-muted-foreground text-sm">{card.description}</span>
        </span>
      </a>
    </li>
  {/each}
</ul>
