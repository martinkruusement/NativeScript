import type { TransformResult, ViteDevServer } from 'vite';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';

import { extractExportMetadata } from '../../../server/websocket-served-module-helpers.js';
import type { RegisterSfcHandlersOptions } from './sfc-route-shared.js';
import { parse, resolveSfcDescriptorId } from './sfc-route-shared.js';

/**
 * Registers `GET /ns/sfc-meta` — JSON metadata (script exports, render presence,
 * hmr id) for an SFC. Extracted verbatim from `websocket-sfc.ts` (pure move).
 */
export function registerSfcMetaRoute(server: ViteDevServer, options: RegisterSfcHandlersOptions): void {
	// 4) JSON metadata endpoint for SFCs: GET /ns/sfc-meta?path=/src/Comp.vue OR /ns/sfc-meta/<ver>?path=/src/Comp.vue
	server.middlewares.use(async (req, res, next) => {
		try {
			const urlObj = new URL(req.url || '', 'http://localhost');
			if (!urlObj.pathname.startsWith('/ns/sfc-meta')) return next();
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
			res.setHeader('Pragma', 'no-cache');
			res.setHeader('Expires', '0');
			// Accept optional version segment similar to /ns/sfc
			{
				const metaBase = '/ns/sfc-meta';
				if (urlObj.pathname.startsWith(metaBase + '/')) {
					const rawRemainder = urlObj.pathname.slice(metaBase.length);
					const parts = rawRemainder.split('/');
					if (parts.length > 2 && /^[0-9]+$/.test(parts[1] || '')) {
						// consume version but we don't need it server-side
					}
				}
			}
			let spec = urlObj.searchParams.get('path') || '';
			if (!spec) {
				res.statusCode = 400;
				res.end(JSON.stringify({ error: 'missing path' }));
				return;
			}
			if (spec.startsWith('@/')) spec = options.appVirtualWithSlash + spec.slice(2);
			if (!spec.startsWith('/')) spec = '/' + spec;
			const base = spec.replace(/[?#].*$/, '');
			// Inspect the variants' exports. An SFC without <script> has none.
			const safeTransform = async (candidate: string): Promise<TransformResult | null> => {
				try {
					return await server.transformRequest(candidate);
				} catch {
					return null;
				}
			};
			const [scriptR, templateR] = await Promise.all([safeTransform(base + '?vue&type=script'), safeTransform(base + '?vue&type=template')]);
			let styleMeta = { hasStyle: false, styleCount: 0, scoped: false, slotted: false, cssModules: false, cssVars: [] as string[], scopeId: null as string | null };
			try {
				const abs = path.join(server.config?.root || process.cwd(), base.replace(/^\//, ''));
				const source = readFileSync(abs, 'utf-8');
				const { descriptor } = parse(source, { filename: abs });
				// `<style src>` blocks have no inline content.
				const styles = descriptor.styles.filter((s) => s.src || s.content.trim());
				const mainR = await safeTransform(base);
				styleMeta = {
					hasStyle: styles.length > 0,
					styleCount: styles.length,
					scoped: styles.some((s) => s.scoped),
					slotted: descriptor.slotted,
					cssModules: styles.some((s) => s.module),
					cssVars: descriptor.cssVars,
					scopeId: resolveSfcDescriptorId({ server, abs, mainCode: mainR?.code, source }),
				};
			} catch (eStyle: any) {
				if (options.verbose) console.warn('[sfc-meta] style inspection failed for', base, eStyle?.message || String(eStyle));
			}
			const scriptCode = scriptR?.code || '';
			const templateCode = templateR?.code || '';
			const scriptMeta = extractExportMetadata(scriptCode);
			// Robust render detection: Vue compiler may emit several shapes:
			// 1) export function render(_ctx, _cache) { ... }
			// 2) function render(_ctx,_cache) { ... } (later exported)
			// 3) export const render = (_ctx,_cache) => { ... }
			// 4) const render = (...) => { ... } (later exported)
			// 5) export { render } or export { render as render }
			// 6) Object property forms (rare in template output) render: (...) => {}
			const hasRender = /export\s+function\s+render\s*\(/.test(templateCode) || /(?:^|\n)\s*function\s+render\s*\(/.test(templateCode) || /export\s+(?:const|let|var)\s+render\s*=/.test(templateCode) || /(?:^|\n)\s*(?:const|let|var)\s+render\s*=/.test(templateCode) || /\brender\s*[:=]\s*/.test(templateCode) || /export\s*\{\s*render\s*(?:as\s*render)?\s*\}/.test(templateCode);
			if (hasRender && options.verbose) {
				console.log('[sfc-meta] detected render for', base);
			} else if (!hasRender && options.verbose) {
				console.warn('[sfc-meta] render NOT detected for', base);
			}
			const hash = createHash('md5').update(base).digest('hex').slice(0, 8);
			const payload = {
				path: base,
				hasScript: !!scriptCode,
				hasTemplate: !!templateCode,
				...styleMeta,
				scriptExports: scriptMeta.named,
				scriptHasDefault: scriptMeta.hasDefault,
				templateHasRender: hasRender,
				hmrId: hash,
			};
			res.statusCode = 200;
			res.end(JSON.stringify(payload));
		} catch (e: any) {
			res.statusCode = 500;
			res.end(JSON.stringify({ error: e?.message || String(e) }));
		}
	});
}
