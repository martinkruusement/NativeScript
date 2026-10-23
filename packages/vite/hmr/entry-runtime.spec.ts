import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { APP_CSS_TAG, installHttpCoreCssSupport, preloadHttpCoreStyleScope } from './entry-runtime.js';
import { getGlobalScope } from './shared/runtime/global-scope.js';

// Models core's selector list: a tagged add appends, a tagged remove drops.
function createTaggedCssCore() {
	const sheets: { tag: string; css: unknown }[] = [];
	return {
		sheets,
		addTaggedAdditionalCSS: vi.fn((css: unknown, tag: string) => {
			sheets.push({ tag, css });
			return true;
		}),
		removeTaggedAdditionalCSS: vi.fn((tag: string) => {
			const kept = sheets.filter((sheet) => sheet.tag !== tag);
			const removed = kept.length !== sheets.length;
			sheets.splice(0, sheets.length, ...kept);
			return removed;
		}),
	};
}

describe('installHttpCoreCssSupport', () => {
	beforeEach(() => {
		delete getGlobalScope().__NS_HMR_APPLY_CSS__;
		delete getGlobalScope().__NS_HMR_APP_CSS__;
		delete getGlobalScope().__NS_HMR_APP_CSS_AST__;
		delete getGlobalScope().__NS_HMR_HTTP_APP_CSS_APPLIED__;
		delete getGlobalScope().__NS_HMR_BOOT_COMPLETE__;
		delete getGlobalScope().__NS_REGISTER_CSS__;
		delete getGlobalScope().__NS_PENDING_CSS__;
		delete getGlobalScope().__NS_CSS_TAG_ORDER__;
		delete getGlobalScope().__NS_CSS_REAPPLY_AFTER__;
		delete getGlobalScope().addTaggedAdditionalCSS;
		delete getGlobalScope().removeTaggedAdditionalCSS;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('replaces app.css selectors via the tagged remove + add pair so deleted rules disappear', () => {
		const addCss = vi.fn();
		const addTaggedAdditionalCSS = vi.fn(() => true);
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		const Application = { addCss, getRootView: vi.fn(() => null) };

		const applier = installHttpCoreCssSupport({ Application, addTaggedAdditionalCSS, removeTaggedAdditionalCSS });
		expect(typeof applier).toBe('function');

		applier!('.foo { color: blue; }');

		expect(removeTaggedAdditionalCSS).toHaveBeenCalledWith(APP_CSS_TAG);
		expect(addTaggedAdditionalCSS).toHaveBeenCalledWith('.foo { color: blue; }', APP_CSS_TAG);
		expect(addCss).not.toHaveBeenCalled();
	});

	it('falls back to additive Application.addCss when the tagged API throws', () => {
		const addCss = vi.fn();
		const addTaggedAdditionalCSS = vi.fn(() => {
			throw new Error('boom');
		});
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		const Application = { addCss, getRootView: vi.fn(() => null) };

		const applier = installHttpCoreCssSupport({ Application, addTaggedAdditionalCSS, removeTaggedAdditionalCSS });
		applier!('.x { color: red; }');

		expect(addCss).toHaveBeenCalledWith('.x { color: red; }');
	});

	it('falls back to additive Application.addCss when the tagged API is absent (e.g. older NS Core)', () => {
		const addCss = vi.fn();
		const onCssStateChange = vi.fn();
		const Application = { addCss, getRootView: vi.fn(() => ({ _onCssStateChange: onCssStateChange })) };
		getGlobalScope().__NS_HMR_APP_CSS__ = '.boot { color: red; }';

		const applier = installHttpCoreCssSupport({ Application }, true);

		expect(typeof applier).toBe('function');
		expect(addCss).toHaveBeenCalledWith('.boot { color: red; }');
		expect(onCssStateChange).toHaveBeenCalled();
		expect(getGlobalScope().__NS_HMR_HTTP_APP_CSS_APPLIED__).toBe(true);
	});

	it('does not refresh the root view when refreshRoot=false', () => {
		const addTaggedAdditionalCSS = vi.fn(() => true);
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		const getRootView = vi.fn();
		const Application = { addCss: vi.fn(), getRootView };

		const applier = installHttpCoreCssSupport({ Application, addTaggedAdditionalCSS, removeTaggedAdditionalCSS });
		applier!('.css { color: red; }', false);

		expect(addTaggedAdditionalCSS).toHaveBeenCalled();
		expect(getRootView).not.toHaveBeenCalled();
	});

	it('skips empty CSS text to avoid no-op selector churn', () => {
		const addCss = vi.fn();
		const addTaggedAdditionalCSS = vi.fn(() => true);
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		const Application = { addCss, getRootView: vi.fn(() => null) };

		const applier = installHttpCoreCssSupport({ Application, addTaggedAdditionalCSS, removeTaggedAdditionalCSS });
		applier!('');

		expect(addCss).not.toHaveBeenCalled();
		expect(addTaggedAdditionalCSS).not.toHaveBeenCalled();
		expect(removeTaggedAdditionalCSS).not.toHaveBeenCalled();
	});

	it('returns null when the coreModule does not expose Application.addCss', () => {
		expect(installHttpCoreCssSupport({})).toBeNull();
	});

	it('cold-boot prefers the rework AST stashed on globalThis over the raw text fallback', () => {
		// `helpers/main-entry.ts` stashes the rework AST on
		// `__NS_HMR_APP_CSS_AST__` so HMR cold boot mirrors the no-HMR
		// rolldown bundle's application path. The raw text remains as a
		// fallback for live HMR edits arriving via the dev-server WS.
		const addCss = vi.fn();
		const addTaggedAdditionalCSS = vi.fn(() => true);
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		const Application = { addCss, getRootView: vi.fn(() => null) };

		const ast = { type: 'stylesheet', stylesheet: { rules: [{ type: 'rule', selectors: ['.text-sm'], declarations: [{ type: 'declaration', property: 'line-height', value: '20' }] }] } };
		getGlobalScope().__NS_HMR_APP_CSS_AST__ = ast;
		getGlobalScope().__NS_HMR_APP_CSS__ = '.text-sm { line-height: 20; }';

		installHttpCoreCssSupport({ Application, addTaggedAdditionalCSS, removeTaggedAdditionalCSS });

		expect(removeTaggedAdditionalCSS).toHaveBeenCalledWith(APP_CSS_TAG);
		expect(addTaggedAdditionalCSS).toHaveBeenCalledTimes(1);
		expect(addTaggedAdditionalCSS).toHaveBeenCalledWith(ast, APP_CSS_TAG);
		expect(addCss).not.toHaveBeenCalled();
		expect(getGlobalScope().__NS_HMR_HTTP_APP_CSS_APPLIED__).toBe(true);
	});

	it('cold-boot falls back to raw text when the AST apply throws', () => {
		const addCss = vi.fn();
		let call = 0;
		const addTaggedAdditionalCSS = vi.fn(() => {
			call += 1;
			if (call === 1) throw new Error('AST not understood');
			return true;
		});
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		const Application = { addCss, getRootView: vi.fn(() => null) };

		getGlobalScope().__NS_HMR_APP_CSS_AST__ = { type: 'stylesheet', stylesheet: { rules: [] } };
		getGlobalScope().__NS_HMR_APP_CSS__ = '.x { color: red; }';

		installHttpCoreCssSupport({ Application, addTaggedAdditionalCSS, removeTaggedAdditionalCSS });

		// First call attempts AST; throws. Second call is raw text via applyCss.
		expect(addTaggedAdditionalCSS).toHaveBeenCalledTimes(2);
		expect(addTaggedAdditionalCSS).toHaveBeenLastCalledWith('.x { color: red; }', APP_CSS_TAG);
		expect(getGlobalScope().__NS_HMR_HTTP_APP_CSS_APPLIED__).toBe(true);
	});

	describe('cascade order across tagged replaces', () => {
		const install = () => {
			const core = createTaggedCssCore();
			const Application = { addCss: vi.fn(), getRootView: vi.fn(() => null) };
			const applier = installHttpCoreCssSupport({ Application, addTaggedAdditionalCSS: core.addTaggedAdditionalCSS, removeTaggedAdditionalCSS: core.removeTaggedAdditionalCSS });
			return { core, Application, applier: applier!, registerCss: getGlobalScope().__NS_REGISTER_CSS__ };
		};

		it('keeps component styles after app.css when app.css is hot-replaced', () => {
			getGlobalScope().__NS_HMR_APP_CSS__ = '.label { color: red; }';
			const { core, applier, registerCss } = install();
			registerCss('sfc:A', '.label { color: green; }');
			registerCss('sfc:B', '.title { color: blue; }');

			applier('.label { color: orange; }');

			expect(core.sheets).toEqual([
				{ tag: APP_CSS_TAG, css: '.label { color: orange; }' },
				{ tag: 'sfc:A', css: '.label { color: green; }' },
				{ tag: 'sfc:B', css: '.title { color: blue; }' },
			]);
		});

		it('keeps a re-registered component tag at its original position', () => {
			const { core, registerCss } = install();
			registerCss('sfc:A', '.a { color: red; }');
			registerCss('sfc:B', '.b { color: red; }');
			registerCss('sfc:C', '.c { color: red; }');

			registerCss('sfc:A', '.a { color: green; }');

			expect(core.sheets).toEqual([
				{ tag: 'sfc:A', css: '.a { color: green; }' },
				{ tag: 'sfc:B', css: '.b { color: red; }' },
				{ tag: 'sfc:C', css: '.c { color: red; }' },
			]);
		});

		it('re-registers only the tags registered after the replaced one', () => {
			const { core, registerCss } = install();
			registerCss('sfc:A', '.a { color: red; }');
			registerCss('sfc:B', '.b { color: red; }');
			registerCss('sfc:C', '.c { color: red; }');
			core.removeTaggedAdditionalCSS.mockClear();

			registerCss('sfc:B', '.b { color: green; }');

			expect(core.removeTaggedAdditionalCSS.mock.calls.map(([tag]) => tag)).toEqual(['sfc:B', 'sfc:C']);
			expect(core.sheets.map((sheet) => sheet.tag)).toEqual(['sfc:A', 'sfc:B', 'sfc:C']);
		});

		it('registers a new tag without re-registering the others', () => {
			const { core, registerCss } = install();
			registerCss('sfc:A', '.a { color: red; }');
			core.removeTaggedAdditionalCSS.mockClear();
			core.addTaggedAdditionalCSS.mockClear();

			registerCss('sfc:B', '.b { color: red; }');

			expect(core.removeTaggedAdditionalCSS.mock.calls).toEqual([['sfc:B']]);
			expect(core.addTaggedAdditionalCSS.mock.calls).toEqual([['.b { color: red; }', 'sfc:B']]);
		});

		it('skips a re-registration whose css is unchanged', () => {
			const { core, Application, registerCss } = install();
			registerCss('sfc:A', '.a { color: red; }');
			registerCss('sfc:B', '.b { color: red; }');
			getGlobalScope().__NS_HMR_BOOT_COMPLETE__ = true;
			core.removeTaggedAdditionalCSS.mockClear();
			core.addTaggedAdditionalCSS.mockClear();

			registerCss('sfc:A', '.a { color: red; }');

			expect(core.removeTaggedAdditionalCSS).not.toHaveBeenCalled();
			expect(core.addTaggedAdditionalCSS).not.toHaveBeenCalled();
			expect(Application.getRootView).not.toHaveBeenCalled();
		});

		it('keeps component styles drained at cold boot after the app.css AST', () => {
			const ast = { type: 'stylesheet', stylesheet: { rules: [] } };
			getGlobalScope().__NS_PENDING_CSS__ = { 'sfc:A': '.label { color: green; }' };
			getGlobalScope().__NS_HMR_APP_CSS_AST__ = ast;

			const { core } = install();

			expect(core.sheets).toEqual([
				{ tag: APP_CSS_TAG, css: ast },
				{ tag: 'sfc:A', css: '.label { color: green; }' },
			]);
		});

		it('keeps component styles drained at cold boot after the raw app.css text', () => {
			getGlobalScope().__NS_PENDING_CSS__ = { 'sfc:A': '.label { color: green; }' };
			getGlobalScope().__NS_HMR_APP_CSS__ = '.label { color: red; }';

			const { core } = install();

			expect(core.sheets.map((sheet) => sheet.tag)).toEqual([APP_CSS_TAG, 'sfc:A']);
		});

		it('does not record a tag whose tagged add failed', () => {
			const { core, registerCss } = install();
			core.addTaggedAdditionalCSS.mockImplementationOnce(() => {
				throw new Error('boom');
			});

			registerCss('sfc:A', '.a { color: red; }');
			expect(getGlobalScope().__NS_CSS_TAG_ORDER__.has('sfc:A')).toBe(false);

			registerCss('sfc:A', '.a { color: red; }');
			expect(core.sheets).toEqual([{ tag: 'sfc:A', css: '.a { color: red; }' }]);
		});

		it('re-registers the tags the HMR client recorded in the shared order', () => {
			getGlobalScope().__NS_CSS_TAG_ORDER__ = new Map([['/src/styles/card.css', '.card { color: green; }']]);
			const { core, applier } = install();

			applier('.card { color: red; }');

			expect(core.sheets).toEqual([
				{ tag: APP_CSS_TAG, css: '.card { color: red; }' },
				{ tag: '/src/styles/card.css', css: '.card { color: green; }' },
			]);
		});

		it('exposes the re-registration on globalThis for the HMR client', () => {
			const { core, registerCss } = install();
			registerCss('sfc:A', '.a { color: red; }');
			registerCss('sfc:B', '.b { color: red; }');
			const reapplyAfter = getGlobalScope().__NS_CSS_REAPPLY_AFTER__;

			expect(reapplyAfter('sfc:A')).toBe(1);
			expect(reapplyAfter('sfc:B')).toBe(0);
			expect(reapplyAfter(null)).toBe(2);
			expect(core.sheets.map((sheet) => sheet.tag)).toEqual(['sfc:A', 'sfc:B']);
		});

		it('does not re-register component styles when app.css falls back to addCss', () => {
			const { core, Application, applier, registerCss } = install();
			registerCss('sfc:A', '.a { color: red; }');
			core.addTaggedAdditionalCSS.mockImplementationOnce(() => {
				throw new Error('boom');
			});
			core.removeTaggedAdditionalCSS.mockClear();

			applier('.x { color: red; }');

			expect(Application.addCss).toHaveBeenCalledWith('.x { color: red; }');
			expect(core.removeTaggedAdditionalCSS.mock.calls).toEqual([[APP_CSS_TAG]]);
		});

		it('records no order when the tagged API is absent', () => {
			const addCss = vi.fn();
			installHttpCoreCssSupport({ Application: { addCss, getRootView: vi.fn(() => null) } });

			getGlobalScope().__NS_REGISTER_CSS__('sfc:A', '.a { color: red; }');
			getGlobalScope().__NS_REGISTER_CSS__('sfc:A', '.a { color: red; }');

			expect(addCss).toHaveBeenCalledTimes(2);
			expect(getGlobalScope().__NS_CSS_TAG_ORDER__.size).toBe(0);
		});
	});
});

describe('preloadHttpCoreStyleScope', () => {
	it('preloads the canonical `/ns/core/ui/styling/style-scope` URL', async () => {
		// Every consumer of `@nativescript/core/ui/styling/style-scope` —
		// this cold-boot preload, app-side imports, vendor `require()`
		// shims via the runtime import map — must land on the same URL
		// string so iOS's HTTP-ESM loader keys them to one module record.
		// Any divergence here re-introduces the class-identity split that
		// caused the gray-screen `Application.resetRootView` regression
		const importer = vi.fn().mockResolvedValue({});
		const result = await preloadHttpCoreStyleScope(importer, 'http://localhost:5173', true);

		expect(importer).toHaveBeenCalledWith('http://localhost:5173/ns/core/ui/styling/style-scope');
		expect(result).toMatchObject({ ok: true, url: 'http://localhost:5173/ns/core/ui/styling/style-scope' });
	});

	it('reports failure when the preload import rejects', async () => {
		const importer = vi.fn().mockRejectedValue(new Error('boom'));
		const result = await preloadHttpCoreStyleScope(importer, 'http://localhost:5173', true);

		expect(result.ok).toBe(false);
		expect(result.err).toContain('boom');
	});
});
