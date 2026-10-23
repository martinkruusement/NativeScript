import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { APP_CSS_TAG, applyCssText, handleCssUpdates } from './css-handler.js';
import { getGlobalScope } from '../shared/runtime/global-scope.js';

describe('css-handler', () => {
	beforeEach(() => {
		delete getGlobalScope().__NS_HMR_APPLY_CSS__;
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
		const removeTaggedAdditionalCSS = vi.fn();
		getGlobalScope().Application = { addCss, getRootView: vi.fn(() => null) };
		getGlobalScope().addTaggedAdditionalCSS = addTaggedAdditionalCSS;
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		applyCssText('');

		expect(addCss).not.toHaveBeenCalled();
		expect(addTaggedAdditionalCSS).not.toHaveBeenCalled();
		expect(removeTaggedAdditionalCSS).not.toHaveBeenCalled();
	});

	it("drops a component tag's rules for empty CSS text and restyles", () => {
		const onCssStateChange = vi.fn();
		const realmApplier = vi.fn();
		const addCss = vi.fn();
		const addTaggedAdditionalCSS = vi.fn(() => true);
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().__NS_HMR_APPLY_CSS__ = realmApplier;
		getGlobalScope().Application = { addCss, getRootView: vi.fn(() => ({ _onCssStateChange: onCssStateChange })) };
		getGlobalScope().addTaggedAdditionalCSS = addTaggedAdditionalCSS;
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		applyCssText('', 'sfc:/src/App.vue');

		expect(removeTaggedAdditionalCSS).toHaveBeenCalledWith('sfc:/src/App.vue');
		expect(addTaggedAdditionalCSS).not.toHaveBeenCalled();
		expect(addCss).not.toHaveBeenCalled();
		expect(realmApplier).not.toHaveBeenCalled();
		expect(onCssStateChange).toHaveBeenCalled();
	});

	it('does not restyle for empty CSS text when the tag had no rules', () => {
		const onCssStateChange = vi.fn();
		const removeTaggedAdditionalCSS = vi.fn(() => false);
		getGlobalScope().Application = { addCss: vi.fn(), getRootView: vi.fn(() => ({ _onCssStateChange: onCssStateChange })) };
		getGlobalScope().addTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		applyCssText('', 'sfc:/src/App.vue');

		expect(removeTaggedAdditionalCSS).toHaveBeenCalledWith('sfc:/src/App.vue');
		expect(onCssStateChange).not.toHaveBeenCalled();
	});

	it('never removes app.css for empty CSS text, even when tagged explicitly', () => {
		const realmApplier = vi.fn();
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().__NS_HMR_APPLY_CSS__ = realmApplier;
		getGlobalScope().Application = { addCss: vi.fn(), getRootView: vi.fn(() => null) };
		getGlobalScope().addTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		applyCssText('', APP_CSS_TAG);

		expect(removeTaggedAdditionalCSS).not.toHaveBeenCalled();
		expect(realmApplier).not.toHaveBeenCalled();
	});

	it("ignores empty CSS text for a tag that is not an SFC's, such as an imported .css file", () => {
		const onCssStateChange = vi.fn();
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().Application = { addCss: vi.fn(), getRootView: vi.fn(() => ({ _onCssStateChange: onCssStateChange })) };
		getGlobalScope().addTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		applyCssText('', '/src/styles/theme.css');

		expect(removeTaggedAdditionalCSS).not.toHaveBeenCalled();
		expect(onCssStateChange).not.toHaveBeenCalled();
	});

	it('keeps a component tag when its fetched update comes back empty', async () => {
		const removeTaggedAdditionalCSS = vi.fn(() => true);
		const emptyFetch = vi.fn(async () => ({ text: async () => '' }));
		vi.stubGlobal('fetch', emptyFetch);
		getGlobalScope().Application = { addCss: vi.fn(), getRootView: vi.fn(() => null) };
		getGlobalScope().addTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;

		await handleCssUpdates([{ path: '/src/app/header/header.component.css', tag: '/src/app/header/header.component.css' }], 'http://localhost:5173');

		expect(emptyFetch).toHaveBeenCalled();
		expect(removeTaggedAdditionalCSS).not.toHaveBeenCalled();
	});
});
