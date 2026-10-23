import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { APP_CSS_TAG, applyCssText, handleCssUpdates } from './css-handler.js';
import { installHttpCoreCssSupport } from '../entry-runtime.js';
import { getGlobalScope } from '../shared/runtime/global-scope.js';

// Models core's selector list: a tagged add appends, a tagged remove drops.
function createTaggedCssCore() {
	const sheets: { tag: string; css: string }[] = [];
	return {
		sheets,
		addTaggedAdditionalCSS: vi.fn((css: string, tag: string) => {
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

describe('css-handler', () => {
	beforeEach(() => {
		delete getGlobalScope().__NS_HMR_APPLY_CSS__;
		delete getGlobalScope().__NS_HMR_APP_CSS__;
		delete getGlobalScope().__NS_HMR_APP_CSS_AST__;
		delete getGlobalScope().__NS_HMR_HTTP_APP_CSS_APPLIED__;
		delete getGlobalScope().__NS_REGISTER_CSS__;
		delete getGlobalScope().__NS_PENDING_CSS__;
		delete getGlobalScope().__NS_CSS_TAG_ORDER__;
		delete getGlobalScope().__NS_CSS_REAPPLY_AFTER__;
		delete getGlobalScope().Application;
		delete getGlobalScope().__nsVendorRegistry;
		delete getGlobalScope().__nsVendorRequire;
		delete getGlobalScope().__nsRequire;
		delete getGlobalScope().require;
		delete getGlobalScope().addTaggedAdditionalCSS;
		delete getGlobalScope().removeTaggedAdditionalCSS;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('prefers the HTTP-realm CSS applier when one is installed (used by HTTP-ESM cold boot)', () => {
		const realmApplier = vi.fn();
		getGlobalScope().__NS_HMR_APPLY_CSS__ = realmApplier;
		getGlobalScope().Application = { addCss: vi.fn(), getRootView: vi.fn() };

		applyCssText('.login { color: red; }');

		expect(realmApplier).toHaveBeenCalledWith('.login { color: red; }', true);
		expect(getGlobalScope().Application.addCss).not.toHaveBeenCalled();
	});

	it('replaces app.css selectors via the tagged remove + add pair so deleted rules disappear', () => {
		const onCssStateChange = vi.fn();
		const addCss = vi.fn();
		const addTaggedAdditionalCSS = vi.fn(() => true);
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().Application = {
			addCss,
			getRootView: vi.fn(() => ({ _onCssStateChange: onCssStateChange })),
		};
		getGlobalScope().addTaggedAdditionalCSS = addTaggedAdditionalCSS;
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		applyCssText('.login { color: red; }');

		expect(removeTaggedAdditionalCSS).toHaveBeenCalledWith(APP_CSS_TAG);
		expect(addTaggedAdditionalCSS).toHaveBeenCalledWith('.login { color: red; }', APP_CSS_TAG);
		expect(addCss).not.toHaveBeenCalled();
		expect(onCssStateChange).toHaveBeenCalled();
	});

	it('never routes a component-tagged update through the HTTP-realm applier (it only replaces the global app.css tag)', () => {
		const realmApplier = vi.fn();
		const addTaggedAdditionalCSS = vi.fn(() => true);
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().__NS_HMR_APPLY_CSS__ = realmApplier;
		getGlobalScope().Application = { addCss: vi.fn(), getRootView: vi.fn(() => null) };
		getGlobalScope().addTaggedAdditionalCSS = addTaggedAdditionalCSS;
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		const tag = '/src/app/header/header.component.css';
		applyCssText('.appstore-header { color: blue; }', tag);

		expect(realmApplier).not.toHaveBeenCalled();
		expect(removeTaggedAdditionalCSS).toHaveBeenCalledWith(tag);
		expect(addTaggedAdditionalCSS).toHaveBeenCalledWith('.appstore-header { color: blue; }', tag);
	});

	it('replaces under a per-component tag (component styleUrls), independent of the app.css tag', () => {
		const onCssStateChange = vi.fn();
		const addTaggedAdditionalCSS = vi.fn(() => true);
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().Application = {
			addCss: vi.fn(),
			getRootView: vi.fn(() => ({ _onCssStateChange: onCssStateChange })),
		};
		getGlobalScope().addTaggedAdditionalCSS = addTaggedAdditionalCSS;
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		const tag = '/src/app/header/header.component.css';
		applyCssText('.appstore-header { background-color: #ff6600; }', tag);

		// Uses the supplied per-file tag — NOT the shared app.css tag — so a
		// component's rules replace without wiping the global stylesheet.
		expect(removeTaggedAdditionalCSS).toHaveBeenCalledWith(tag);
		expect(addTaggedAdditionalCSS).toHaveBeenCalledWith('.appstore-header { background-color: #ff6600; }', tag);
		expect(removeTaggedAdditionalCSS).not.toHaveBeenCalledWith(APP_CSS_TAG);
		expect(onCssStateChange).toHaveBeenCalled();
	});

	it('falls back to additive Application.addCss when the tagged API throws', () => {
		const addCss = vi.fn();
		getGlobalScope().Application = { addCss, getRootView: vi.fn(() => null) };
		getGlobalScope().addTaggedAdditionalCSS = vi.fn(() => {
			throw new Error('boom');
		});
		getGlobalScope().removeTaggedAdditionalCSS = vi.fn(() => true);

		applyCssText('.x { color: red; }');

		expect(addCss).toHaveBeenCalledWith('.x { color: red; }');
	});

	it('falls back to additive Application.addCss when the tagged API is absent', () => {
		const onCssStateChange = vi.fn();
		const addCss = vi.fn();
		getGlobalScope().Application = {
			addCss,
			getRootView: vi.fn(() => ({ _onCssStateChange: onCssStateChange })),
		};

		applyCssText('.login { color: red; }');

		expect(addCss).toHaveBeenCalledWith('.login { color: red; }');
		expect(onCssStateChange).toHaveBeenCalled();
	});

	it('skips empty CSS text', () => {
		const addCss = vi.fn();
		const addTaggedAdditionalCSS = vi.fn();
		getGlobalScope().Application = { addCss, getRootView: vi.fn(() => null) };
		getGlobalScope().addTaggedAdditionalCSS = addTaggedAdditionalCSS;
		getGlobalScope().removeTaggedAdditionalCSS = vi.fn();

		applyCssText('');

		expect(addCss).not.toHaveBeenCalled();
		expect(addTaggedAdditionalCSS).not.toHaveBeenCalled();
	});

	describe('cascade order across tagged replaces', () => {
		const installCore = () => {
			const core = createTaggedCssCore();
			const onCssStateChange = vi.fn();
			getGlobalScope().Application = { addCss: vi.fn(), getRootView: vi.fn(() => ({ _onCssStateChange: onCssStateChange })) };
			getGlobalScope().addTaggedAdditionalCSS = core.addTaggedAdditionalCSS;
			getGlobalScope().removeTaggedAdditionalCSS = core.removeTaggedAdditionalCSS;
			return { ...core, onCssStateChange };
		};

		it('keeps component styles after app.css when app.css is replaced through the tagged API', () => {
			const core = installCore();
			applyCssText('.label { color: red; }');
			applyCssText('.label { color: green; }', '/src/a.css');
			applyCssText('.title { color: blue; }', '/src/b.css');

			applyCssText('.label { color: orange; }');

			expect(core.sheets).toEqual([
				{ tag: APP_CSS_TAG, css: '.label { color: orange; }' },
				{ tag: '/src/a.css', css: '.label { color: green; }' },
				{ tag: '/src/b.css', css: '.title { color: blue; }' },
			]);
		});

		it('keeps a replaced component tag at its original position', () => {
			const core = installCore();
			applyCssText('.a { color: red; }', '/src/a.css');
			applyCssText('.b { color: red; }', '/src/b.css');
			applyCssText('.c { color: red; }', '/src/c.css');

			applyCssText('.a { color: green; }', '/src/a.css');

			expect(core.sheets).toEqual([
				{ tag: '/src/a.css', css: '.a { color: green; }' },
				{ tag: '/src/b.css', css: '.b { color: red; }' },
				{ tag: '/src/c.css', css: '.c { color: red; }' },
			]);
			expect([...getGlobalScope().__NS_CSS_TAG_ORDER__.keys()]).toEqual(['/src/a.css', '/src/b.css', '/src/c.css']);
		});

		it('re-registers the tags the entry runtime recorded in the shared order', () => {
			getGlobalScope().__NS_CSS_TAG_ORDER__ = new Map([
				['/src/a.css', '.a { color: red; }'],
				['sfc:B', '.b { color: red; }'],
			]);
			const core = installCore();
			core.sheets.push({ tag: '/src/a.css', css: '.a { color: red; }' }, { tag: 'sfc:B', css: '.b { color: red; }' });

			applyCssText('.a { color: green; }', '/src/a.css');

			expect(core.sheets.map((sheet) => sheet.tag)).toEqual(['/src/a.css', 'sfc:B']);
		});

		it('records a new component tag without re-registering the others', () => {
			const core = installCore();
			applyCssText('.a { color: red; }', '/src/a.css');
			core.removeTaggedAdditionalCSS.mockClear();

			applyCssText('.b { color: red; }', '/src/b.css');

			expect(core.removeTaggedAdditionalCSS.mock.calls).toEqual([['/src/b.css']]);
			expect([...getGlobalScope().__NS_CSS_TAG_ORDER__.keys()]).toEqual(['/src/a.css', '/src/b.css']);
		});

		it('skips a component update whose css is unchanged', () => {
			const core = installCore();
			applyCssText('.a { color: red; }', '/src/a.css');
			core.removeTaggedAdditionalCSS.mockClear();
			core.addTaggedAdditionalCSS.mockClear();
			core.onCssStateChange.mockClear();

			applyCssText('.a { color: red; }', '/src/a.css');

			expect(core.removeTaggedAdditionalCSS).not.toHaveBeenCalled();
			expect(core.addTaggedAdditionalCSS).not.toHaveBeenCalled();
			expect(core.onCssStateChange).not.toHaveBeenCalled();
		});

		it('delegates the re-registration to the entry runtime when it is installed', () => {
			const core = installCore();
			const reapplyAfter = vi.fn(() => 0);
			getGlobalScope().__NS_CSS_REAPPLY_AFTER__ = reapplyAfter;
			applyCssText('.a { color: red; }', '/src/a.css');
			applyCssText('.b { color: red; }', '/src/b.css');
			expect(reapplyAfter).not.toHaveBeenCalled();
			core.removeTaggedAdditionalCSS.mockClear();

			applyCssText('.a { color: green; }', '/src/a.css');
			applyCssText('.label { color: red; }');

			expect(reapplyAfter.mock.calls).toEqual([['/src/a.css'], [null]]);
			expect(core.removeTaggedAdditionalCSS.mock.calls).toEqual([['/src/a.css'], [APP_CSS_TAG]]);
			expect(getGlobalScope().__NS_CSS_TAG_ORDER__.get('/src/a.css')).toBe('.a { color: green; }');
		});

		it('leaves the app.css order to the HTTP-realm applier when one is installed', () => {
			const realmApplier = vi.fn();
			const reapplyAfter = vi.fn(() => 0);
			getGlobalScope().__NS_HMR_APPLY_CSS__ = realmApplier;
			getGlobalScope().__NS_CSS_REAPPLY_AFTER__ = reapplyAfter;
			installCore();

			applyCssText('.label { color: red; }');

			expect(realmApplier).toHaveBeenCalledWith('.label { color: red; }', true);
			expect(reapplyAfter).not.toHaveBeenCalled();
		});

		it('does not record a tag whose tagged replace failed', () => {
			const core = installCore();
			core.addTaggedAdditionalCSS.mockImplementationOnce(() => {
				throw new Error('boom');
			});

			applyCssText('.a { color: red; }', '/src/a.css');

			expect(getGlobalScope().Application.addCss).toHaveBeenCalledWith('.a { color: red; }');
			expect(getGlobalScope().__NS_CSS_TAG_ORDER__).toBeUndefined();
		});

		describe('a copy of app.css imported from app code', () => {
			const appCssUpdate = { type: 'css-update', path: '/src/app.css', acceptedPath: '/src/app.css', timestamp: 1 };
			const serveCss = (cssText: string) =>
				vi.stubGlobal(
					'fetch',
					vi.fn(async () => ({ text: async () => cssText })),
				);

			it('refreshes the copy registered under the app.css path', async () => {
				const core = installCore();
				applyCssText('.title { color: red; }');
				applyCssText('.title { color: red; }', '/src/app.css');
				applyCssText('.label { color: green; }', '/src/a.css');
				serveCss('.title { color: blue; }');

				await handleCssUpdates([appCssUpdate], 'http://dev');

				expect(core.sheets).toEqual([
					{ tag: APP_CSS_TAG, css: '.title { color: blue; }' },
					{ tag: '/src/app.css', css: '.title { color: blue; }' },
					{ tag: '/src/a.css', css: '.label { color: green; }' },
				]);
			});

			it('refreshes that copy through the entry runtime appliers', async () => {
				const core = createTaggedCssCore();
				const Application = { addCss: vi.fn(), getRootView: vi.fn(() => null) };
				getGlobalScope().Application = Application;
				getGlobalScope().addTaggedAdditionalCSS = core.addTaggedAdditionalCSS;
				getGlobalScope().removeTaggedAdditionalCSS = core.removeTaggedAdditionalCSS;
				getGlobalScope().__NS_HMR_APP_CSS__ = '.title { color: red; }';
				installHttpCoreCssSupport({ Application, addTaggedAdditionalCSS: core.addTaggedAdditionalCSS, removeTaggedAdditionalCSS: core.removeTaggedAdditionalCSS });
				getGlobalScope().__NS_REGISTER_CSS__('/src/app.css', '.title { color: red; }');
				getGlobalScope().__NS_REGISTER_CSS__('sfc:A', '.label { color: green; }');
				serveCss('.title { color: blue; }');

				await handleCssUpdates([appCssUpdate], 'http://dev');

				expect(core.sheets).toEqual([
					{ tag: APP_CSS_TAG, css: '.title { color: blue; }' },
					{ tag: '/src/app.css', css: '.title { color: blue; }' },
					{ tag: 'sfc:A', css: '.label { color: green; }' },
				]);
			});

			it('adds no copy when app code does not import app.css', async () => {
				const core = installCore();
				applyCssText('.title { color: red; }');
				applyCssText('.label { color: green; }', '/src/a.css');
				serveCss('.title { color: blue; }');

				await handleCssUpdates([appCssUpdate], 'http://dev');

				expect(core.sheets).toEqual([
					{ tag: APP_CSS_TAG, css: '.title { color: blue; }' },
					{ tag: '/src/a.css', css: '.label { color: green; }' },
				]);
			});
		});
	});
});
