<script lang="ts">
	import { onMount, tick } from 'svelte';

	type UiMessage = { role: 'agent' | 'founder'; text: string; kind: 'text' | 'question' | 'choices' };

	const PRESETS = [
		{ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelHint: 'e.g. anthropic/claude-sonnet-4.5' },
		{ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'e.g. gpt-4.1-mini' },
		{ name: 'Custom (OpenAI-compatible)', baseUrl: '', modelHint: 'any OpenAI-compatible base URL' }
	];

	let phase = $state<'loading' | 'setup' | 'chat'>('loading');
	let messages = $state<UiMessage[]>([]);
	let sessionId = $state<string | null>(null);
	let input = $state('');
	let streaming = $state(false);
	let progress = $state<string | null>(null);
	let setupError = $state<string | null>(null);
	let setupBaseUrl = $state(PRESETS[0]!.baseUrl);
	let setupKey = $state('');
	let setupModel = $state('');
	let threadEl = $state<HTMLElement | null>(null);

	onMount(() => {
		void bootstrap();
	});

	async function bootstrap() {
		const res = await fetch('/api/session', { method: 'POST' });
		const data = await res.json();
		if (!data.providerConfigured) {
			phase = 'setup';
			return;
		}
		if (data.error) {
			messages.push({ role: 'agent', text: `Something broke on our side: ${data.error}`, kind: 'text' });
		}
		sessionId = data.sessionId;
		const transcript = (data.transcript ?? []) as UiMessage[];
		// The resume promise, made visible: re-entry shows where you left off
		// (first-conversation.md P1 — "nothing is lost, ever").
		messages =
			data.companyName && transcript.length > 0
				? [
						{ role: 'agent', text: `You were setting up ${data.companyName} — where were we?`, kind: 'text' },
						...transcript
					]
				: transcript;
		phase = 'chat';
		await scrollDown();
	}

	function pickPreset(name: string) {
		const preset = PRESETS.find((p) => p.name === name);
		if (preset?.baseUrl) setupBaseUrl = preset.baseUrl;
		else if (preset) setupBaseUrl = '';
	}

	async function saveProvider(e: SubmitEvent) {
		e.preventDefault();
		setupError = null;
		const res = await fetch('/api/provider', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ baseUrl: setupBaseUrl, apiKey: setupKey, model: setupModel })
		});
		const data = await res.json();
		if (!data.ok) {
			setupError = data.error ?? 'That did not work — check the details and try again.';
			return;
		}
		await bootstrap();
	}

	async function send(e: SubmitEvent) {
		e.preventDefault();
		const text = input.trim();
		if (!text || streaming || !sessionId) return;
		input = '';
		streaming = true;
		messages.push({ role: 'founder', text, kind: 'text' });
		await scrollDown();
		try {
			const res = await fetch('/api/turn', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, message: text })
			});
			if (!res.ok || !res.body) {
				const err = await res.json().catch(() => ({ error: 'The connection failed.' }));
				messages.push({ role: 'agent', text: `✗ ${err.error}`, kind: 'text' });
				streaming = false;
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buffer.indexOf('\n\n')) !== -1) {
					const chunk = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					if (!chunk.startsWith('data:')) continue;
					handleEvent(JSON.parse(chunk.slice(5)));
				}
			}
		} catch (cause) {
			messages.push({ role: 'agent', text: `✗ ${(cause as Error).message}`, kind: 'text' });
		}
		streaming = false;
		progress = null;
		await scrollDown();
	}

	function handleEvent(event: Record<string, unknown>) {
		if (event.type === 'text_delta') {
			const last = messages.at(-1);
			if (!last || last.role !== 'agent' || last.kind !== 'text') {
				messages.push({ role: 'agent', text: '', kind: 'text' });
			}
			messages[messages.length - 1]!.text += event.text as string;
		} else if (event.type === 'tool_call') {
			const name = (event.call as { function: { name: string } }).function.name;
			if (name !== 'ask_question') progress = `→ ${name}`;
		} else if (event.type === 'tool_result') {
			const name = (event.call as { function: { name: string } }).function.name;
			if (event.isError) {
				progress = `✗ ${name} failed — the agent sees the error and recovers`;
				return;
			}
			if (name === 'ask_question' || name === 'offer_choices') {
				const parsed = JSON.parse(event.result as string) as { asked?: string; choices?: string[] };
				if (parsed.asked) {
					messages.push({
						role: 'agent',
						text: parsed.choices
							? `${parsed.asked}\n1) ${parsed.choices[0]}\n2) ${parsed.choices[1]}`
							: parsed.asked,
						kind: parsed.choices ? 'choices' : 'question'
					});
				}
				progress = null;
			} else if (name === 'save_answer') {
				progress = '✓ saved — it remembers';
			} else if (name === 'skip_question' || name === 'mark_not_needed') {
				progress = '✓ noted';
			}
		} else if (event.type === 'error') {
			messages.push({ role: 'agent', text: `✗ ${event.message}`, kind: 'text' });
		}
		void scrollDown();
	}

	async function scrollDown() {
		await tick();
		threadEl?.scrollTo({ top: threadEl.scrollHeight });
	}
</script>

{#if phase === 'loading'}
	<p class="muted">Starting…</p>
{:else if phase === 'setup'}
	<form class="setup" onsubmit={saveProvider}>
		<h1>Your company OS</h1>
		<p class="lead">
			Three things and we start: who translates your words into a website (any OpenAI-compatible
			provider), your key, and a model. The key is stored in <em>your</em> database, on <em>your</em> server.
		</p>

		<label>
			Provider
			<select
				value={PRESETS.find((p) => p.baseUrl === setupBaseUrl)?.name ?? (PRESETS[2]?.name ?? '')}
				onchange={(e) => pickPreset(e.currentTarget.value)}
			>
				{#each PRESETS as preset (preset.name)}
					<option>{preset.name}</option>
				{/each}
			</select>
		</label>

		<label>
			Base URL
			<input type="url" required placeholder="https://…" bind:value={setupBaseUrl} />
		</label>

		<label>
			API key
			<input type="password" required placeholder="sk-…" bind:value={setupKey} autocomplete="off" />
		</label>

		<label>
			Model
			<input type="text" required placeholder="model id" bind:value={setupModel} />
		</label>

		{#if setupError}
			<p class="error">✗ {setupError}</p>
		{/if}

		<button type="submit" disabled={!setupBaseUrl.trim() || !setupKey.trim() || !setupModel.trim()}>
			Check and start
		</button>
		<p class="muted small">We test the key with one real request before saving anything.</p>
	</form>
{:else}
	<div class="thread" bind:this={threadEl}>
		{#each messages as message, i (i)}
			<div class="msg {message.role} {message.kind}">
				{#each message.text.split('\n') as line, j (j)}
					{#if j > 0}<br />{/if}{line}
				{/each}
			</div>
		{/each}
		{#if progress}
			<div class="progress">{progress}</div>
		{/if}
		{#if streaming && !progress}
			<div class="progress">…</div>
		{/if}
	</div>

	<form class="composer" onsubmit={send}>
		<input
			type="text"
			placeholder="Type your answer…"
			bind:value={input}
			disabled={streaming || !sessionId}
			autocomplete="off"
		/>
		<button type="submit" disabled={streaming || !input.trim() || !sessionId}>Send</button>
	</form>
{/if}

<style>
	.muted {
		color: #8a867f;
	}
	.small {
		font-size: 0.85rem;
	}
	.setup {
		margin: auto;
		width: 100%;
		max-width: 460px;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 3rem 0;
	}
	.setup h1 {
		font-size: 1.6rem;
		margin: 0;
		letter-spacing: -0.02em;
	}
	.lead {
		color: #4a4742;
		margin: 0;
	}
	.setup label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.9rem;
		color: #4a4742;
	}
	.setup input,
	.setup select {
		font: inherit;
		padding: 0.6rem 0.7rem;
		border: 1px solid #d8d4cd;
		border-radius: 8px;
		background: #fff;
		color: inherit;
	}
	.setup button {
		font: inherit;
		padding: 0.65rem;
		border: 0;
		border-radius: 8px;
		background: #1c1b1a;
		color: #faf9f7;
		cursor: pointer;
	}
	.setup button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.error {
		color: #a33d2e;
		margin: 0;
		font-size: 0.9rem;
	}
	.thread {
		flex: 1;
		overflow-y: auto;
		padding: 1rem 0;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	.msg {
		max-width: 82%;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.msg.agent {
		align-self: flex-start;
	}
	.msg.founder {
		align-self: flex-end;
		background: #eceae4;
		padding: 0.55rem 0.85rem;
		border-radius: 14px 14px 3px 14px;
	}
	.msg.question,
	.msg.choices {
		font-weight: 550;
	}
	.progress {
		align-self: flex-start;
		color: #8a867f;
		font-size: 0.85rem;
	}
	.composer {
		display: flex;
		gap: 0.6rem;
		padding: 0.9rem 0 1.2rem;
		position: sticky;
		bottom: 0;
		background: #faf9f7;
	}
	.composer input {
		flex: 1;
		font: inherit;
		padding: 0.7rem 0.9rem;
		border: 1px solid #d8d4cd;
		border-radius: 10px;
		background: #fff;
		color: inherit;
	}
	.composer button {
		font: inherit;
		padding: 0.7rem 1.1rem;
		border: 0;
		border-radius: 10px;
		background: #1c1b1a;
		color: #faf9f7;
		cursor: pointer;
	}
	.composer button:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
