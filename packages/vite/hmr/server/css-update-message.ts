import type { ViteDevServer } from 'vite';
import * as path from 'path';
import { getServerOrigin } from './server-origin.js';
import { normalizeCssForDevice } from './css-device-module.js';
import type { CssUpdateItem, CssUpdatesMessage } from '../shared/protocol.js';

/**
 * Canonical helpers for the `ns:css-updates` wire message. Every server-side
 * emitter (the `.css`-edit branch of the hot-update prologue, the Tailwind
 * content-file path in content-css-update.ts, and the connect-time sync in
 * css-connect-sync.ts) builds its payload here so the path math and message
 * shape have exactly one implementation.
 */

/**
 * Root-relative posix path (leading slash) for the app stylesheet, or `null`
 * when the path escapes the project root — an escaped path would produce a
 * `/../…` fetch URL the device cannot resolve, so callers skip the broadcast.
 */
export function appCssRootRelPath(root: string, appCssAbsPath: string): string | null {
	const rootPosix = root.replace(/\\/g, '/').replace(/\/$/, '');
	const rel = path.posix.normalize(path.posix.relative(rootPosix, appCssAbsPath.replace(/\\/g, '/')));
	if (!rel || rel === '.' || rel.startsWith('..')) {
		return null;
	}
	return rel.startsWith('/') ? rel : `/${rel}`;
}

/** One `css-update` item. `tag` scopes component-style replaces; omitted for the global stylesheet. */
export function buildCssUpdateItem(cssPath: string, opts: { tag?: string; timestamp?: number; cssText?: string | null } = {}): CssUpdateItem {
	return {
		type: 'css-update',
		path: cssPath,
		acceptedPath: cssPath,
		timestamp: opts.timestamp ?? Date.now(),
		...(opts.tag ? { tag: opts.tag } : {}),
		...(typeof opts.cssText === 'string' ? { cssText: opts.cssText } : {}),
	};
}

/**
 * Compiles a root-relative stylesheet the way the dev server answers the device's `<path>?direct=1` fetch.
 * @param server The Vite dev server.
 * @param cssPath Root-relative stylesheet path, as broadcast in the `css-update` item.
 * @param opts `verbose` logs transform failures.
 * @returns The device-ready css, or `null` when neither the `?direct` nor the `?inline` transform yields css.
 */
export async function loadCssUpdateText(server: ViteDevServer, cssPath: string, opts: { verbose?: boolean } = {}): Promise<string | null> {
	const withQuery = (query: string) => `${cssPath}${cssPath.includes('?') ? '&' : '?'}${query}`;
	try {
		const direct = await server.transformRequest(withQuery('direct'));
		const code = direct?.code;
		// Plain css only; a js module shape falls through to `?inline`.
		if (typeof code === 'string' && code.length && !/^\s*(?:import|export)\b/.test(code)) {
			return normalizeCssForDevice(code);
		}
	} catch (error) {
		if (opts.verbose) console.warn('[hmr-ws] css ?direct transform failed for', cssPath, (error as Error)?.message || String(error));
	}
	try {
		const inline = await server.transformRequest(withQuery('inline'));
		// `?inline` output is `export default "<compiled css>"`.
		const match = /export\s+default\s+("(?:[^"\\]|\\.)*")\s*;?/s.exec(inline?.code || '');
		if (match) {
			const css = JSON.parse(match[1]);
			if (typeof css === 'string') {
				return normalizeCssForDevice(css);
			}
		}
	} catch (error) {
		if (opts.verbose) console.warn('[hmr-ws] css ?inline transform failed for', cssPath, (error as Error)?.message || String(error));
	}
	return null;
}

export function buildCssUpdatesMessage(server: ViteDevServer, updates: CssUpdateItem[], opts: { reason?: 'connect-sync' } = {}): CssUpdatesMessage {
	return {
		type: 'ns:css-updates',
		origin: getServerOrigin(server),
		updates,
		...(opts.reason ? { reason: opts.reason } : {}),
	};
}
