/**
 * Framework-agnostic CSS delivery for HMR. Beyond `app.css`, every CSS source (a
 * JS/TS `import './x.css'`, a Vue SFC `<style>`) needs an explicit bridge to the
 * device's tagged-CSS API — under HMR there's no DOM for Vite's default CSS
 * module to inject into, so it would otherwise be dropped.
 *
 * Bridge: a device-side applier `globalThis.__NS_REGISTER_CSS__(tag, cssText)`
 * installed at client boot (see `hmr/client/index.ts`, `hmr/entry-runtime.ts`),
 * plus a snippet (built here) emitted into each CSS-bearing module that calls
 * it. The per-source `tag` lets hot-updates replace a source's rules without
 * touching siblings. Flavor-specific extraction (SFC blocks vs. file) feeds
 * these shared builders.
 */

// Style-language specifiers (optionally with a query string).
export const CSS_MODULE_RE = /\.(css|scss|sass|less|styl|stylus)(\?|$)/i;

/**
 * Strip a leading BOM and `@charset` (sass emits one for non-ASCII content);
 * NativeScript's styling engine has no use for either.
 */
export function normalizeCssForDevice(css: string): string {
	if (!css) return '';
	return css.replace(/^﻿/, '').replace(/@charset\s+["'][^"']*["'];?\s*/gi, '');
}

// Vue's scoped transform renames `@keyframes x` to `x-<8 hex scope id>`.
const SCOPED_KEYFRAMES_RE = /@(?:-webkit-)?keyframes\s+([A-Za-z_][\w-]*-[0-9a-f]{8})(?![\w-])/g;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Append a letter to each Vue scoped keyframes name (`<name>-<8 hex>`) that ends
 * in a digit, in its `@keyframes` rule and in every reference to it. Core's
 * `animation:` shorthand parser takes such a name for the iteration count; drop
 * this once that parser anchors its token patterns.
 * @param css Compiled css text.
 * @returns The css with those keyframes renamed.
 */
export function renameDigitTerminatedScopedKeyframes(css: string): string {
	if (!css || !css.includes('keyframes')) return css;
	const renames = new Map<string, string>();
	for (const match of css.matchAll(SCOPED_KEYFRAMES_RE)) {
		if (/\d$/.test(match[1])) renames.set(match[1], `${match[1]}x`);
	}
	let out = css;
	for (const [from, to] of renames) {
		out = out.replace(new RegExp(`(^|[^\\w-])${escapeRegExp(from)}(?![\\w-])`, 'g'), `$1${to}`);
	}
	return out;
}

// Device-safe IIFE: apply via the client applier, else queue for drain-on-install.
function buildRegisterCall(tagExpr: string, cssExpr: string): string {
	return `\n;(function(){try{var g=globalThis;var __t=${tagExpr};var __c=${cssExpr};var __r=g.__NS_REGISTER_CSS__;if(typeof __r==='function'){__r(__t,__c);}else{(g.__NS_PENDING_CSS__=g.__NS_PENDING_CSS__||{})[__t]=__c;}}catch(__e){}})();\n`;
}

/** Register a CSS string literal under `tag`. `''` for empty CSS. */
export function buildCssRegisterSnippet(tag: string, cssText: string): string {
	if (!cssText || !cssText.trim()) return '';
	return buildRegisterCall(JSON.stringify(tag), JSON.stringify(cssText));
}

/**
 * Register `''` under `tag`, which the device appliers take as "drop this tag's rules".
 * @param tag The tag the source registered its css under.
 */
export function buildCssUnregisterSnippet(tag: string): string {
	return buildRegisterCall(JSON.stringify(tag), '""');
}

/**
 * Register CSS held in an in-scope module variable under `tag`. Used by the
 * generic `.css` handler (reuses Vite's `?inline` binding). For an imported file
 * `tag` is its root-relative path — the same tag the `.css` live-edit path uses,
 * so edits replace instead of stacking.
 */
export function buildCssRegisterSnippetFromVar(tag: string, varName: string): string {
	return buildRegisterCall(JSON.stringify(tag), varName);
}
