<script lang="ts">
  /**
   * The calendar's "Week numbers" switch (Contribute 9ae58a4e). It sits in
   * the page's form: a click posts the opposite of what is shown
   * (`weekNumbers=on|off`), saved for the person on the server.
   */
  let { on }: { on: boolean } = $props()
</script>

<button
  type="submit"
  role="switch"
  aria-checked={on}
  aria-label="Show week numbers"
  name="weekNumbers"
  value={on ? 'off' : 'on'}
  class="inline-flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-[13px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  data-testid="calendar-week-numbers"
>
  <span
    class="relative inline-block h-4 w-7 shrink-0 rounded-full border border-border transition-colors {on
      ? 'bg-primary'
      : 'bg-muted'}"
    aria-hidden="true"
  >
    <span
      class="absolute top-0.5 size-3 rounded-full bg-background shadow-sm transition-[left] {on
        ? 'left-3.5'
        : 'left-0.5'}"
    ></span>
  </span>
  <span>Week numbers</span>
</button>
