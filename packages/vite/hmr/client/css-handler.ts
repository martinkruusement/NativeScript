import { getCore } from './utils.js';
import { getGlobalScope } from '../shared/runtime/global-scope.js';
import { restyleRootAndModals } from '../shared/runtime/restyle-roots.js';

const VERBOSE = !!getGlobalScope().__NS_ENV_VERBOSE__;

// Must match the tag used by the boot virtual `app.css` emitter in
// `helpers/main-entry.ts` and `entry-runtime.ts::APP_CSS_TAG` so HMR's
// remove/add pair replaces the boot-time selectors instead of stacking.
export const APP_CSS_TAG = 'app.css';

function getPreferredCssApplier(): ((cssText: string, refreshRoot?: boolean) => void) | null {
	try {
		const applier = getGlobalScope().__NS_HMR_APPLY_CSS__;
		if (typeof applier === 'function') {
			return applier;
		}
	} catch {}
	return null;
}

type TaggedCssApi = {
	add?: (cssText: string, tag: string) => unknown;
	remove?: (tag: string) => unknown;
};

function resolveTaggedCssApi(): TaggedCssApi {
	const add = getCore('addTaggedAdditionalCSS');
	const remove = getCore('removeTaggedAdditionalCSS');
	if (typeof add === 'function' && typeof remove === 'function') {
		return { add, remove };
	}
	return {};
}

// CSS helper: apply CSS and refresh the current page so new styles render.
//
// `tag` scopes the remove+add tagged pair. It defaults to {@link APP_CSS_TAG}
// (`'app.css'`) so a global stylesheet edit replaces the boot-time selectors.
// Component `styleUrls` edits pass the style file's own path as the tag so a
// component's rules replace independently — applying a component's CSS under
// the shared `app.css` tag would otherwise wipe the global stylesheet.
export function applyCssText(cssText: string, tag: string = APP_CSS_TAG): void {
	if (typeof cssText !== 'string' || !cssText.length) return;

	try {
		// The HTTP-core-realm applier (entry-runtime's `__NS_HMR_APPLY_CSS__`)
		// always replaces under the global `app.css` tag, so it is only correct
		// for GLOBAL stylesheet updates — routing a component-tagged update
		// through it would wipe the global stylesheet and install the
		// component's rules in its place. Component tags take the tagged
		// remove+add path below.
		if (tag === APP_CSS_TAG) {
			const applyInHttpCoreRealm = getPreferredCssApplier();
			if (applyInHttpCoreRealm) {
				applyInHttpCoreRealm(cssText, true);
				if (VERBOSE) console.info('[ns-hmr] CSS applied through HTTP core realm');
				return;
			}
		}

		// Replace selectors via remove + add tagged pair so deleted
		// rules disappear (the additive `Application.addCss` cannot
		// undo previously installed selectors).
		const taggedCss = resolveTaggedCssApi();
		const Application = getCore('Application');
		let appliedTagged = false;
		if (taggedCss.add && taggedCss.remove) {
			try {
				taggedCss.remove(tag);
				taggedCss.add(cssText, tag);
				appliedTagged = true;
				if (VERBOSE) console.info(`[ns-hmr] CSS applied via tagged replace (tag=${tag})`);
			} catch (taggedError: any) {
				console.warn('[ns-hmr] tagged CSS replace failed, falling back to addCss:', taggedError?.message || String(taggedError));
			}
		}
		if (!appliedTagged && Application && Application.addCss) {
			Application.addCss(cssText);
			if (VERBOSE) console.info('[ns-hmr] CSS applied via addCss (additive fallback)');
		}
		// NS caches computed styles — re-trigger styling on the root
		// (propagates to descendants via `eachDescendant`) and on every
		// presented modal, which is a root of its own.
		try {
			restyleRootAndModals(Application?.getRootView?.());
		} catch {}
	} catch (e) {
		console.warn('[ns-hmr] CSS apply failed:', e?.message || String(e));
	}
}

export const CSS_FETCH_TIMEOUT_MS = 10000;

/**
 * Fetches the stylesheet for an update without `cssText` (older server, or css it could not compile).
 * @param url Absolute stylesheet URL.
 * @param timeoutMs Time after which an unsettled request is abandoned.
 * @returns The response text, or `''` when the request fails or times out.
 */
export async function fetchText(url: string, timeoutMs: number = CSS_FETCH_TIMEOUT_MS): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
	});
	const request = (async () => {
		// Core Http bypasses XMLHttpRequest polyfills that can leave fetch() hanging.
		const Http = getCore('Http');
		if (Http && typeof Http.getString === 'function') {
			return await Http.getString(url);
		}
		const g = getGlobalScope();
		if (typeof g.fetch === 'function') {
			const res = await g.fetch(url);
			return await res.text();
		}
		if (VERBOSE) console.warn('[ns-hmr] No fetch method available');
		return '';
	})();
	try {
		const text = await Promise.race([request, timeout]);
		if (text === undefined) {
			console.warn(`[ns-hmr] CSS fetch did not complete within ${timeoutMs}ms: ${url}`);
			return '';
		}
		return text;
	} catch (e) {
		console.warn('[ns-hmr] Fetch failed:', e?.message || String(e));
		return '';
	} finally {
		clearTimeout(timer);
	}
}

// Handle CSS updates from Vite
export async function handleCssUpdates(cssUpdates: any[], httpOrigin: string): Promise<void> {
	if (VERBOSE) console.info('[ns-hmr] handleCssUpdates called, updates:', cssUpdates?.length, 'origin:', httpOrigin);
	for (const update of cssUpdates) {
		try {
			const cssPath = update.path || update.acceptedPath || '';
			if (!cssPath) continue;

			let cssText: string;
			if (typeof update.cssText === 'string') {
				cssText = update.cssText;
				if (VERBOSE) console.info('[ns-hmr] CSS update carried its text:', cssPath);
			} else {
				if (!httpOrigin) continue;

				// Build URL: origin + path + ?direct=1&t=<timestamp>
				const timestamp = update.timestamp || Date.now();
				const sep = cssPath.includes('?') ? '&' : '?';
				const url = `${httpOrigin}${cssPath}${sep}direct=1&t=${timestamp}`;

				if (VERBOSE) console.info('[ns-hmr] Fetching CSS:', url);
				cssText = await fetchText(url);
			}
			if (cssText) {
				// `tag` scopes the replace: app entry CSS (no tag) uses the
				// default `app.css` tag; component `styleUrls` edits carry their
				// own path so they replace independently of the global stylesheet.
				const tag = typeof update.tag === 'string' && update.tag ? update.tag : undefined;
				applyCssText(cssText, tag);
			}
		} catch (e) {
			console.warn('[ns-hmr] CSS update fetch/apply failed:', e?.message || String(e));
		}
	}
}

// Handle custom CSS events
export function handleCustomCss(cssText: string): void {
	if (typeof cssText === 'string' && cssText.length) {
		applyCssText(cssText);
	}
}
