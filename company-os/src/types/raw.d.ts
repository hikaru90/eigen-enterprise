/** Vite ?raw imports — build-time inlined file contents (see modules/website). */
declare module '*?raw' {
	const content: string;
	export default content;
}
