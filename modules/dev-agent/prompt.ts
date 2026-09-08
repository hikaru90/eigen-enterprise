/**
 * Canonical home of the pi prompt contract is the kernel
 * (`src/lib/kernel/pi-engine.ts`) — the engine owns spawning AND the prompt.
 * This re-export keeps the dev-agent module surface stable.
 */
export { PI_GUARDRAILS, buildPiPrompt } from '$lib/kernel/pi-engine'
