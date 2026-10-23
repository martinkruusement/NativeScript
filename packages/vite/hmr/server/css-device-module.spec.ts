import { describe, expect, it, vi } from 'vitest';

import { buildCssRegisterSnippet, buildCssUnregisterSnippet, renameDigitTerminatedScopedKeyframes } from './css-device-module.js';

describe('renameDigitTerminatedScopedKeyframes', () => {
	it('renames a digit-terminated scoped keyframes rule and every reference to it', () => {
		const css = ['@keyframes spin-96572f36 { from { opacity: 0; } to { opacity: 1; } }', '@-webkit-keyframes spin-96572f36 { to { opacity: 1; } }', '.a[data-v-96572f36] { animation: spin-96572f36 1s infinite; }', '.b[data-v-96572f36] { animation-name:spin-96572f36; }'].join('\n');
		const out = renameDigitTerminatedScopedKeyframes(css);
		expect(out).toContain('@keyframes spin-96572f36x {');
		expect(out).toContain('@-webkit-keyframes spin-96572f36x {');
		expect(out).toContain('animation: spin-96572f36x 1s infinite;');
		expect(out).toContain('animation-name:spin-96572f36x;');
		expect(out).not.toMatch(/spin-96572f36(?!x)/);
	});

	it('leaves the scope attribute of the selectors alone', () => {
		const out = renameDigitTerminatedScopedKeyframes('@keyframes spin-96572f36 { to { opacity: 1; } }\n.a[data-v-96572f36] { animation: spin-96572f36 1s; }');
		expect(out).toContain('.a[data-v-96572f36]');
	});

	it('leaves letter-terminated scoped names, plain names and other hyphenated names alone', () => {
		const css = ['@keyframes fade-abcdef0a { to { opacity: 1; } }', '@keyframes plain { to { opacity: 1; } }', '@keyframes slide-2 { to { opacity: 1; } }', '@keyframes pulse-1234567 { to { opacity: 1; } }', '.a { animation: fade-abcdef0a 1s, plain 2s, slide-2 3s, pulse-1234567 4s; }'].join('\n');
		expect(renameDigitTerminatedScopedKeyframes(css)).toBe(css);
	});

	it('does not rename a longer name that merely starts with a renamed one', () => {
		const out = renameDigitTerminatedScopedKeyframes('@keyframes spin-96572f36 { to { opacity: 1; } }\n.a { animation: spin-96572f36-slow 1s; }');
		expect(out).toContain('spin-96572f36-slow 1s');
	});

	it('returns css without keyframes unchanged', () => {
		const css = '.a[data-v-96572f36] { color: red; }';
		expect(renameDigitTerminatedScopedKeyframes(css)).toBe(css);
		expect(renameDigitTerminatedScopedKeyframes('')).toBe('');
	});
});

describe('buildCssUnregisterSnippet', () => {
	it('registers an empty string under the tag', () => {
		const g = { __NS_REGISTER_CSS__: vi.fn() };
		new Function('globalThis', buildCssUnregisterSnippet('sfc:/src/App.vue'))(g);
		expect(g.__NS_REGISTER_CSS__).toHaveBeenCalledWith('sfc:/src/App.vue', '');
	});

	it('queues the empty string when no applier is installed yet', () => {
		const g: Record<string, any> = {};
		new Function('globalThis', buildCssUnregisterSnippet('sfc:/src/App.vue'))(g);
		expect(g.__NS_PENDING_CSS__).toEqual({ 'sfc:/src/App.vue': '' });
	});

	it('is emitted where the register snippet emits nothing', () => {
		expect(buildCssRegisterSnippet('sfc:/src/App.vue', '')).toBe('');
		expect(buildCssUnregisterSnippet('sfc:/src/App.vue')).not.toBe('');
	});
});
