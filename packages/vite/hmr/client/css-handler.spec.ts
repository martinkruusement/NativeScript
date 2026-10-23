import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { APP_CSS_TAG, CSS_FETCH_TIMEOUT_MS, applyCssText, fetchText, handleCssUpdates } from './css-handler.js';
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
});

describe('handleCssUpdates', () => {
	let addTaggedAdditionalCSS: ReturnType<typeof vi.fn>;
	let removeTaggedAdditionalCSS: ReturnType<typeof vi.fn>;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		delete getGlobalScope().__NS_HMR_APPLY_CSS__;
		delete getGlobalScope().__nsVendorRegistry;
		delete getGlobalScope().Http;
		addTaggedAdditionalCSS = vi.fn(() => true);
		removeTaggedAdditionalCSS = vi.fn(() => true);
		getGlobalScope().Application = { addCss: vi.fn(), getRootView: vi.fn(() => null) };
		getGlobalScope().addTaggedAdditionalCSS = addTaggedAdditionalCSS;
		getGlobalScope().removeTaggedAdditionalCSS = removeTaggedAdditionalCSS;
		fetchMock = vi.fn(async () => ({ text: async () => '.fetched { color: green; }' }));
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		delete getGlobalScope().Application;
		delete getGlobalScope().Http;
		delete getGlobalScope().addTaggedAdditionalCSS;
		delete getGlobalScope().removeTaggedAdditionalCSS;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('applies the css carried by the update without fetching', async () => {
		const getString = vi.fn();
		getGlobalScope().Http = { getString };

		await handleCssUpdates([{ type: 'css-update', path: '/src/app.css', acceptedPath: '/src/app.css', timestamp: 1, cssText: '.a { color: red; }' }], 'http://test:5173');

		expect(addTaggedAdditionalCSS).toHaveBeenCalledWith('.a { color: red; }', APP_CSS_TAG);
		expect(getString).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('applies carried css under the update tag, even without an http origin', async () => {
		const tag = '/src/app/header/header.component.css';

		await handleCssUpdates([{ type: 'css-update', path: tag, acceptedPath: tag, timestamp: 1, tag, cssText: '.h { color: blue; }' }], '');

		expect(removeTaggedAdditionalCSS).toHaveBeenCalledWith(tag);
		expect(addTaggedAdditionalCSS).toHaveBeenCalledWith('.h { color: blue; }', tag);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('neither fetches nor applies when the carried css is empty', async () => {
		await handleCssUpdates([{ type: 'css-update', path: '/src/app.css', acceptedPath: '/src/app.css', timestamp: 1, cssText: '' }], 'http://test:5173');

		expect(fetchMock).not.toHaveBeenCalled();
		expect(addTaggedAdditionalCSS).not.toHaveBeenCalled();
	});

	it('fetches <origin><path>?direct=1&t=<timestamp> when the update carries no css (older server)', async () => {
		const getString = vi.fn(async () => '.fetched { color: green; }');
		getGlobalScope().Http = { getString };

		await handleCssUpdates([{ type: 'css-update', path: '/src/app.css', acceptedPath: '/src/app.css', timestamp: 42 }], 'http://test:5173');

		expect(getString).toHaveBeenCalledWith('http://test:5173/src/app.css?direct=1&t=42');
		expect(addTaggedAdditionalCSS).toHaveBeenCalledWith('.fetched { color: green; }', APP_CSS_TAG);
	});

	it('skips an update without css when there is no http origin to fetch from', async () => {
		await handleCssUpdates([{ type: 'css-update', path: '/src/app.css', acceptedPath: '/src/app.css', timestamp: 1 }], '');

		expect(fetchMock).not.toHaveBeenCalled();
		expect(addTaggedAdditionalCSS).not.toHaveBeenCalled();
	});
});

describe('fetchText', () => {
	afterEach(() => {
		delete getGlobalScope().Http;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('prefers core Http.getString over the global fetch', async () => {
		const getString = vi.fn(async () => '.http {}');
		const fetchMock = vi.fn();
		getGlobalScope().Http = { getString };
		vi.stubGlobal('fetch', fetchMock);

		expect(await fetchText('http://test:5173/src/app.css?direct=1')).toBe('.http {}');
		expect(getString).toHaveBeenCalledWith('http://test:5173/src/app.css?direct=1');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('falls back to the global fetch when core Http is unavailable', async () => {
		const fetchMock = vi.fn(async () => ({ text: async () => '.fetch {}' }));
		vi.stubGlobal('fetch', fetchMock);

		expect(await fetchText('http://test:5173/src/app.css?direct=1')).toBe('.fetch {}');
		expect(fetchMock).toHaveBeenCalledWith('http://test:5173/src/app.css?direct=1');
	});

	it('returns an empty string and warns when the request fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		getGlobalScope().Http = { getString: vi.fn(async () => Promise.reject(new Error('offline'))) };

		expect(await fetchText('http://test:5173/src/app.css?direct=1')).toBe('');
		expect(warn).toHaveBeenCalledWith('[ns-hmr] Fetch failed:', 'offline');
	});

	it('abandons a request that never settles after CSS_FETCH_TIMEOUT_MS and warns', async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		getGlobalScope().Http = { getString: vi.fn(() => new Promise<string>(() => {})) };
		let settled: string | undefined;

		const pending = fetchText('http://test:5173/src/app.css?direct=1').then((text) => (settled = text));
		await vi.advanceTimersByTimeAsync(CSS_FETCH_TIMEOUT_MS - 1);
		expect(settled).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		await pending;

		expect(settled).toBe('');
		expect(warn).toHaveBeenCalledWith(`[ns-hmr] CSS fetch did not complete within ${CSS_FETCH_TIMEOUT_MS}ms: http://test:5173/src/app.css?direct=1`);
	});

	it('clears the timeout once the request settles', async () => {
		vi.useFakeTimers();
		getGlobalScope().Http = { getString: vi.fn(async () => '.http {}') };

		expect(await fetchText('http://test:5173/src/app.css?direct=1')).toBe('.http {}');
		expect(vi.getTimerCount()).toBe(0);
	});
});
