<script lang="ts">
	let { children } = $props();
</script>

<main>
	{@render children()}
</main>

<style>
	:global(html) {
		background: #faf9f7;
		color: #1c1b1a;
		font-family:
			-system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		font-size: 16px;
		line-height: 1.55;
	}
	:global(body) {
		margin: 0;
		min-height: 100vh;
	}
	main {
		max-width: 720px;
		margin: 0 auto;
		padding: 2rem 1.25rem 0;
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}
</style>
