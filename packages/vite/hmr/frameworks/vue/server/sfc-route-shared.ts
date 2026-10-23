import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'path';
import type { ViteDevServer } from 'vite';
import type { SFCDescriptor, SFCStyleBlock } from '@vue/compiler-sfc';

import traverse from '@babel/traverse';

import { vueSfcCompiler } from './compiler.js';
import { normalizeCssForDevice, renameDigitTerminatedScopedKeyframes } from '../../../server/css-device-module.js';
import type { FrameworkServerStrategy } from '../../../server/framework-strategy.js';

/**
 * Plugin-closure dependencies the SFC route handlers need. The pure transform
 * functions (`cleanCode`, `processCodeForDevice`, `rewriteImports`) and the
 * device-origin resolver (`getServerOrigin`) are imported directly (from
 * `websocket-device-transform.ts` / `server-origin.ts`); only genuine plugin
 * state is injected here.
 */
export interface RegisterSfcHandlersOptions {
	verbose: boolean;
	appVirtualWithSlash: string;
	sfcFileMap: Map<string, string>;
	depFileMap: Map<string, string>;
	getStrategy(): FrameworkServerStrategy;
}

// Babel/Vue-compiler singletons shared by the SFC route modules (serve + assemble).
// Extracted verbatim from the former websocket-sfc.ts module scope so the routes
// resolve the exact same instances they did when they lived in one file.
export const babelTraverse: any = (traverse as any)?.default || (traverse as any);
export const { parse, compileTemplate, compileScript, compileStyleAsync } = vueSfcCompiler;

// Resolve the style preprocessor (`sass`, …) from the APP's node_modules (the
// package the build uses), not the framework's. Cached per root.
const projectRequireCache = new Map<string, NodeRequire>();
function getProjectRequire(projectRoot: string): NodeRequire {
	let req = projectRequireCache.get(projectRoot);
	if (!req) {
		req = createRequire(path.join(projectRoot, 'package.json'));
		projectRequireCache.set(projectRoot, req);
	}
	return req;
}

// @vitejs/plugin-vue's `attrsToQuery` ignore list.
const STYLE_ATTR_IGNORE = new Set(['id', 'index', 'src', 'type', 'lang', 'module', 'scoped', 'generic']);

// The style sub-request @vitejs/plugin-vue emits for a block, plus `&inline`.
function buildSfcStyleRequest(requestBase: string, block: SFCStyleBlock, index: number, scopeId: string, src: string | null): string {
	let query = `?vue&type=style&index=${index}`;
	if (src) query += `&src=${src}`;
	// `&inline` must precede `lang.<ext>`, which vite:css expects last.
	query += '&inline';
	if (block.scoped) query += `&scoped=${scopeId}`;
	for (const [name, value] of Object.entries(block.attrs)) {
		if (STYLE_ATTR_IGNORE.has(name)) continue;
		query += `&${encodeURIComponent(name)}${value ? `=${encodeURIComponent(String(value))}` : ''}`;
	}
	return `${requestBase}${query}&lang.${block.lang || 'css'}`;
}

function parseInlineCssExport(code: string | undefined): string | null {
	const match = code ? /export\s+default\s+("(?:[^"\\]|\\.)*")\s*;?/s.exec(code) : null;
	if (!match) return null;
	try {
		const css = JSON.parse(match[1]);
		return typeof css === 'string' ? css : null;
	} catch {
		return null;
	}
}

const CSS_URL_RE = /(?<![\w-])url\(\s*(?:(["'])(.*?)\1|([^'"()\s]+))\s*\)/g;

// Vite's dev url prefix for files under `dirUrl` (see its `fileToDevUrl`).
function devServerUrlPrefix(server: ViteDevServer, dirUrl: string): string {
	const origin = (server.config?.server?.origin || '').replace(/\/+$/, '');
	const base = (server.config?.base || '/').replace(/^\/*/, '/').replace(/\/*$/, '/');
	return `${origin}${base}${dirUrl.replace(/^\/+/, '').replace(/\/*$/, '/')}`;
}

// Vite rebases `url()`s to dev-server paths; give app files back as `~/`.
function restoreAppRootUrls(css: string, appUrlPrefix: string): string {
	if (!css.includes('url(')) return css;
	return css.replace(CSS_URL_RE, (match, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
		const url = quoted ?? bare ?? '';
		if (!url.startsWith(appUrlPrefix)) return match;
		// Drop the `t=` query Vite adds to an asset after it hot-updates.
		const rest = url.slice(appUrlPrefix.length).replace(/([?&])t=\d+(&|$)/, (_m, sep: string, next: string) => (next ? sep : ''));
		return `url(${quote ?? ''}~/${rest}${quote ?? ''})`;
	});
}

// `<style src>` resolves like plugin-vue's `linkSrcToDescriptor`: Vite's resolver, aliases included.
async function resolveStyleSrc(server: ViteDevServer | undefined, src: string, importer: string): Promise<string> {
	try {
		const resolved = await server?.pluginContainer?.resolveId?.(src, importer);
		if (resolved?.id && !resolved.external && path.isAbsolute(resolved.id)) return resolved.id.replace(/[?#].*$/, '');
	} catch {}
	return path.resolve(path.dirname(importer), src);
}

// Vite's url for a file: root-relative inside the root, else `/@fs/`.
function devRequestPath(projectRoot: string, file: string): string {
	const rel = path.relative(projectRoot, file);
	if (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) return '/' + rel.split(path.sep).join('/');
	return '/@fs/' + file.split(path.sep).join('/').replace(/^\/+/, '');
}

// Stylesheet file → root-relative paths of SFCs whose styles depend on it.
const styleDependencyIndex = new Map<string, Set<string>>();

function styleDependencyKey(file: string): string {
	return path.resolve(file).replace(/\\/g, '/');
}

function indexStyleDependency(file: string, base: string): void {
	const key = styleDependencyKey(file);
	let bases = styleDependencyIndex.get(key);
	if (!bases) {
		bases = new Set();
		styleDependencyIndex.set(key, bases);
	}
	bases.add(base);
}

// The files Vite's css pipeline read for a style sub-request (`@import`, `@use`).
async function indexViteStyleDependencies(server: ViteDevServer, url: string, base: string): Promise<void> {
	try {
		const graph = server.environments?.client?.moduleGraph ?? server.moduleGraph;
		const mod = await graph?.getModuleByUrl(url);
		for (const dep of mod?.importedModules ?? []) {
			if (dep.file) indexStyleDependency(dep.file, base);
		}
	} catch {}
}

/**
 * Whether @vitejs/plugin-vue compiles in production mode (its `isProduction`).
 * @param server The dev server, whose resolved config plugin-vue reads.
 * @returns True when plugin-vue compiles for production.
 */
export function isProductionCompile(server?: ViteDevServer): boolean {
	return server?.config?.isProduction ?? process.env.NODE_ENV === 'production';
}

/**
 * The `descriptor.id` @vitejs/plugin-vue assigns an SFC: the hash behind `data-v-<id>`,
 * `__scopeId` and `v-bind()` variable names. Read from plugin-vue's main transform output,
 * else recomputed the way its `createDescriptor` does without a custom `componentIdGenerator`.
 * @param opts.server The dev server.
 * @param opts.abs Absolute path of the SFC.
 * @param opts.mainCode Output of plugin-vue's main transform of the SFC, if available.
 * @param opts.source SFC source text.
 * @returns The descriptor id.
 */
export function resolveSfcDescriptorId(opts: { server?: ViteDevServer; abs: string; mainCode?: string; source: string }): string {
	const { server, abs, mainCode, source } = opts;
	if (mainCode) {
		const fromMain = /__hmrId\s*=\s*["']([0-9a-f]{6,})["']/.exec(mainCode) || /[?&]scoped=([0-9a-f]{6,})/.exec(mainCode);
		if (fromMain) return fromMain[1];
	}
	const root = server?.config?.root || process.cwd();
	const rel = path.posix.normalize(path.relative(root, abs).split(path.sep).join('/'));
	return createHash('sha256')
		.update(isProductionCompile(server) ? rel + source : rel)
		.digest('hex')
		.slice(0, 8);
}

async function compileStyleBlockDirect(opts: { block: SFCStyleBlock; source: string; filename: string; projectRoot: string; scopeId: string; isProd: boolean; modulesOptions: unknown; verbose: boolean }): Promise<{ css: string; modules: Record<string, string> | null; failed: boolean; dependencies: string[] }> {
	const { block, filename, verbose } = opts;
	const lang = (block.lang || '').toLowerCase();
	const projectRequire = getProjectRequire(opts.projectRoot);
	const res: any = await (compileStyleAsync as any)({
		source: opts.source,
		filename,
		id: `data-v-${opts.scopeId}`,
		scoped: !!block.scoped,
		modules: !!block.module,
		...(block.module && opts.modulesOptions && typeof opts.modulesOptions === 'object' ? { modulesOptions: opts.modulesOptions } : {}),
		isProd: opts.isProd,
		...(lang && lang !== 'css' ? { preprocessLang: lang, preprocessCustomRequire: (id: string) => projectRequire(id) } : {}),
	});
	if (res?.errors?.length && verbose) {
		console.warn(
			'[sfc-asm][style] compile errors',
			filename,
			res.errors.map((e: any) => e?.message || String(e)),
		);
	}
	return { css: res?.code || '', modules: res?.modules || null, failed: !!res?.errors?.length, dependencies: Array.from(res?.dependencies ?? []) };
}

/**
 * Compiled `<style>` blocks of one SFC.
 */
export interface SfcStyleCompileResult {
	/** Device css of every block, scoped selectors and `v-bind()` variables resolved. */
	css: string;
	/** Class maps of `<style module>` blocks by injection name (`$style`), to attach as `__cssModules`. */
	cssModules: Record<string, Record<string, string>> | null;
	/** The descriptor id the blocks were scoped with. */
	scopeId: string;
	/** Whether a block could not be read or compiled, so its rules are missing from `css`. */
	failed: boolean;
}

/**
 * Inputs of {@link compileSfcStyles}.
 */
export interface CompileSfcStylesOptions {
	server?: ViteDevServer;
	descriptor: SFCDescriptor;
	/** Root-relative SFC path, e.g. `/src/Home.vue`. */
	base: string;
	abs: string;
	projectRoot: string;
	/** Root-relative app directory, e.g. `/src/`: the directory `~/` stands for. */
	appVirtualWithSlash: string;
	/** Descriptor id; resolved with {@link resolveSfcDescriptorId} when omitted. */
	scopeId?: string;
	mainCode?: string;
	verbose?: boolean;
	/** Compile only this block. */
	onlyIndex?: number;
}

/**
 * Compile an SFC's `<style>` blocks for the device. Each block goes through the Vite css pipeline
 * with the sub-request @vitejs/plugin-vue emits (postcss, preprocessors, `@import`, scoping,
 * `v-bind()`), falling back to `@vue/compiler-sfc`; `<style module>` blocks always compile with
 * `@vue/compiler-sfc` to get their class map. The pipeline's dev-server `url()`s of app files
 * are given back as `~/` urls. A block that fails to compile is skipped and sets `failed`.
 * @param opts The SFC and how to compile it.
 * @returns The device css, the css module class maps, the scope id and whether a block failed.
 */
export async function compileSfcStyles(opts: CompileSfcStylesOptions): Promise<SfcStyleCompileResult> {
	const { server, descriptor, base, abs, projectRoot, onlyIndex } = opts;
	const verbose = !!opts.verbose;
	const scopeId = opts.scopeId || resolveSfcDescriptorId({ server, abs, mainCode: opts.mainCode, source: descriptor.source });
	const isProd = isProductionCompile(server);
	const result: SfcStyleCompileResult = { css: '', cssModules: null, scopeId, failed: false };
	const out: string[] = [];
	for (let i = 0; i < descriptor.styles.length; i++) {
		if (onlyIndex !== undefined && i !== onlyIndex) continue;
		const block = descriptor.styles[i];
		const srcAbs = block.src ? await resolveStyleSrc(server, block.src, abs) : null;
		let source = block.content;
		if (srcAbs) {
			indexStyleDependency(srcAbs, base);
			try {
				source = readFileSync(srcAbs, 'utf-8');
			} catch (e: any) {
				if (verbose) console.warn('[sfc-asm][style] cannot read <style src>', srcAbs, e?.message || String(e));
				result.failed = true;
				continue;
			}
		}
		if (!source.trim()) continue;
		let css: string | null = null;
		let modules: Record<string, string> | null = null;
		if (!block.module && server) {
			// `<style src>` blocks are requested under the stylesheet's own path.
			const requestBase = srcAbs ? devRequestPath(projectRoot, srcAbs) : base;
			const url = buildSfcStyleRequest(requestBase, block, i, scopeId, srcAbs ? (block.scoped ? scopeId : 'true') : null);
			try {
				css = parseInlineCssExport((await server.transformRequest(url))?.code);
				if (css === null && verbose) console.warn('[sfc-asm][style] no inline css from', url);
			} catch (e: any) {
				if (verbose) console.warn('[sfc-asm][style] vite pipeline failed, compiling directly', url, e?.message || String(e));
			}
			if (css !== null) {
				css = restoreAppRootUrls(css, devServerUrlPrefix(server, opts.appVirtualWithSlash));
				await indexViteStyleDependencies(server, url, base);
			}
		}
		if (css === null) {
			try {
				const direct = await compileStyleBlockDirect({ block, source, filename: srcAbs || abs, projectRoot, scopeId, isProd, modulesOptions: server?.config?.css?.modules, verbose });
				({ css, modules } = direct);
				result.failed ||= direct.failed;
				for (const dep of direct.dependencies) indexStyleDependency(dep, base);
			} catch (e: any) {
				if (verbose) console.warn('[sfc-asm][style] compile failed', base, i, e?.message || String(e));
				result.failed = true;
				continue;
			}
		}
		if (css.trim()) out.push(css);
		if (modules && block.module) {
			(result.cssModules ||= {})[typeof block.module === 'string' ? block.module : '$style'] = modules;
		}
	}
	result.css = renameDigitTerminatedScopedKeyframes(normalizeCssForDevice(out.join('\n')));
	return result;
}

/**
 * The SFCs whose `<style>` blocks depend on a stylesheet (`@import`, `@use`, `<style src>`), as
 * recorded by {@link compileSfcStyles}.
 * @param file Absolute path of the stylesheet.
 * @returns Root-relative SFC paths, e.g. `/src/Home.vue`.
 */
export function getSfcsDependingOnStylesheet(file: string): string[] {
	return Array.from(styleDependencyIndex.get(styleDependencyKey(file)) ?? []);
}

export const pluginTransformTypescript: any = (() => {
	const requireFromHere = createRequire(import.meta.url);
	const loaded = requireFromHere('@babel/plugin-transform-typescript');
	return loaded?.default || loaded;
})();

/**
 * Canonicalize app-source `/ns/m/` imports inside a served Vue SFC artifact
 * (assembler module or `/ns/sfc` variant): strip any `__ns_hmr__/<tag>/`
 * segment (stale cached device code) so every import lands on the STABLE
 * `/ns/m/<app-path>` URL.
 *
 * Why canonical (not versioned): module identity IS the URL. Freshness for
 * changed deps comes from explicit eviction — ns:module `invalidateModules` drops
 * the canonical key from V8's registry AND arms the runtime's bust-next-fetch
 * nonce, so the artifact's re-import re-fetches current content. Emitting a
 * versioned URL would mint a NEW module identity per save (the runtime no
 * longer collapses tags), splitting module state.
 *
 * Vendor (`node_modules`) paths pass through untouched (they're already
 * stable and never tagged).
 */
export function canonicalizeNsMAppImports(code: string): string {
	if (!code) return code;
	const canonicalSpec = (_match: string, prefix: string, origin: string, rest: string, suffix: string): string => {
		return `${prefix}${origin}/ns/m/${rest}${suffix}`;
	};
	// `from "/ns/m/..."` (covers import/export-from), stripping any existing tag
	code = code.replace(/(from\s+["'])((?:https?:\/\/[^"']+)?)\/ns\/m\/(?:__ns_hmr__\/[^/"']+\/)?([^"']*)(["'])/g, canonicalSpec);
	// side-effect `import "/ns/m/..."`
	code = code.replace(/(import\s+["'])((?:https?:\/\/[^"']+)?)\/ns\/m\/(?:__ns_hmr__\/[^/"']+\/)?([^"']*)(["'])/g, canonicalSpec);
	// dynamic `import("/ns/m/...")`
	code = code.replace(/(import\(\s*["'])((?:https?:\/\/[^"']+)?)\/ns\/m\/(?:__ns_hmr__\/[^/"']+\/)?([^"']*)(["']\s*\))/g, canonicalSpec);
	return code;
}
