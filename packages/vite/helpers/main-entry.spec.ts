import { describe, expect, it, vi } from 'vitest';

vi.mock('./flavor.js', () => ({ getProjectFlavor: () => 'typescript' }));
// main-entry reads package.json `main` at load; the test cwd may lack one.
vi.mock('./project.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./project.js')>()), getPackageJson: () => ({ main: 'src/app.ts' }) }));

import { BUNDLE_CSS_AST_SENTINEL } from './bundle-css.js';
import { mainEntryPlugin } from './main-entry.js';

const CSS = '@keyframes spin-96572f36 { to { opacity: 1; } }\n.a[data-v-96572f36] { animation: spin-96572f36 1s infinite; }';

function inlineBundleCssFor(flavor: string, hmrActive = false): string {
	const bundle: Record<string, any> = {
		'bundle.mjs': { type: 'chunk', fileName: 'bundle.mjs', isEntry: true, code: `m("${BUNDLE_CSS_AST_SENTINEL}")`, imports: [], dynamicImports: [], viteMetadata: { importedCss: new Set(['assets/bundle.css']) } },
		'assets/bundle.css': { type: 'asset', fileName: 'assets/bundle.css', source: CSS },
	};
	const plugin = mainEntryPlugin({ platform: 'android', isDevMode: false, verbose: false, hmrActive, useHttps: false, flavor });
	plugin.generateBundle(undefined, bundle);
	return bundle['bundle.mjs'].code;
}

describe('mainEntryPlugin bundle css', () => {
	it('renames digit-terminated Vue scoped keyframes before parsing', () => {
		const code = inlineBundleCssFor('vue');
		expect(code).toContain('"name":"spin-96572f36x"');
		expect(code).toContain('spin-96572f36x 1s infinite');
		expect(code).not.toMatch(/spin-96572f36(?!x)/);
	});

	it('leaves the css of other flavors untouched', () => {
		for (const flavor of ['angular', 'react', 'solid', 'svelte', 'typescript', 'javascript']) {
			const code = inlineBundleCssFor(flavor);
			expect(code).toContain('"name":"spin-96572f36"');
			expect(code).not.toContain('spin-96572f36x');
		}
	});

	it('does not inline bundle css in HMR builds', () => {
		expect(inlineBundleCssFor('vue', true)).toBe(`m("${BUNDLE_CSS_AST_SENTINEL}")`);
	});
});
