/** wrangler is configured to bundle *.html as a text module (see wrangler.jsonc "rules"). */
declare module '*.html' {
	const contents: string;
	export default contents;
}
