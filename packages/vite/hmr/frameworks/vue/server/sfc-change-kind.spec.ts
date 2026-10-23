import { describe, expect, it } from 'vitest';
import { classifySfcChange, seedSfcSignature, sfcScriptSignature, type SfcSignatureStore } from './sfc-change-kind';

const FILE = '/app/screens/Radio.vue';

function sfc(parts: { template?: string; script?: string; scriptSetup?: string; style?: string }): string {
	const blocks: string[] = [];
	if (parts.template !== undefined) blocks.push(`<template>${parts.template}</template>`);
	if (parts.script !== undefined) blocks.push(`<script lang="ts">${parts.script}</script>`);
	if (parts.scriptSetup !== undefined) blocks.push(`<script setup lang="ts">${parts.scriptSetup}</script>`);
	if (parts.style !== undefined) blocks.push(`<style>${parts.style}</style>`);
	return blocks.join('\n');
}

describe('sfcScriptSignature', () => {
	it('ignores template and style content', async () => {
		const a = await sfcScriptSignature(sfc({ template: '<Label text="a" />', scriptSetup: 'const x = 1;', style: '.a { color: red; }' }), FILE);
		const b = await sfcScriptSignature(sfc({ template: '<Label text="b" />', scriptSetup: 'const x = 1;', style: '.a { color: blue; }' }), FILE);
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	it('separates a changed script from an unchanged one', async () => {
		const a = await sfcScriptSignature(sfc({ template: '<Label />', scriptSetup: 'const x = 1;' }), FILE);
		const b = await sfcScriptSignature(sfc({ template: '<Label />', scriptSetup: 'const x = 2;' }), FILE);
		expect(a).not.toBe(b);
	});

	it('distinguishes <script setup> from a plain <script> with the same body', async () => {
		const a = await sfcScriptSignature(sfc({ template: '<Label />', script: 'const x = 1;' }), FILE);
		const b = await sfcScriptSignature(sfc({ template: '<Label />', scriptSetup: 'const x = 1;' }), FILE);
		expect(a).not.toBe(b);
	});

	it('returns null for a source it cannot parse', async () => {
		expect(await sfcScriptSignature('<template><Label></template', FILE)).toBeNull();
	});
});

describe('classifySfcChange', () => {
	it('is full the first time a path is seen', async () => {
		const store: SfcSignatureStore = new Map();
		expect(await classifySfcChange(FILE, sfc({ template: '<Label />', scriptSetup: 'const x = 1;' }), FILE, store)).toBe('full');
	});

	it('is render-only when only the template changed', async () => {
		const store: SfcSignatureStore = new Map();
		await classifySfcChange(FILE, sfc({ template: '<Label text="a" />', scriptSetup: 'const x = 1;' }), FILE, store);
		expect(await classifySfcChange(FILE, sfc({ template: '<Label text="b" />', scriptSetup: 'const x = 1;' }), FILE, store)).toBe('render-only');
	});

	it('is render-only when only a style block changed', async () => {
		const store: SfcSignatureStore = new Map();
		await classifySfcChange(FILE, sfc({ template: '<Label />', scriptSetup: 'const x = 1;', style: '.a { color: red; }' }), FILE, store);
		expect(await classifySfcChange(FILE, sfc({ template: '<Label />', scriptSetup: 'const x = 1;', style: '.a { color: blue; }' }), FILE, store)).toBe('render-only');
	});

	it('is full when the script changed', async () => {
		const store: SfcSignatureStore = new Map();
		await classifySfcChange(FILE, sfc({ template: '<Label />', scriptSetup: 'const x = 1;' }), FILE, store);
		expect(await classifySfcChange(FILE, sfc({ template: '<Label />', scriptSetup: 'const x = 2;' }), FILE, store)).toBe('full');
	});

	it('is full again after an unparseable save, and does not claim render-only on the recovery', async () => {
		const store: SfcSignatureStore = new Map();
		const good = sfc({ template: '<Label />', scriptSetup: 'const x = 1;' });
		await classifySfcChange(FILE, good, FILE, store);
		expect(await classifySfcChange(FILE, '<template><Label></template', FILE, store)).toBe('full');
		// The broken save dropped the baseline, so the next one cannot be proven
		// render-only even though its scripts match the last good version.
		expect(await classifySfcChange(FILE, good, FILE, store)).toBe('full');
	});

	it('tracks paths independently', async () => {
		const store: SfcSignatureStore = new Map();
		const other = '/app/screens/Library.vue';
		await classifySfcChange(FILE, sfc({ template: '<Label text="a" />', scriptSetup: 'const x = 1;' }), FILE, store);
		await classifySfcChange(other, sfc({ template: '<Label text="a" />', scriptSetup: 'const y = 1;' }), other, store);
		expect(await classifySfcChange(FILE, sfc({ template: '<Label text="b" />', scriptSetup: 'const x = 1;' }), FILE, store)).toBe('render-only');
		expect(await classifySfcChange(other, sfc({ template: '<Label text="a" />', scriptSetup: 'const y = 2;' }), other, store)).toBe('full');
	});
});

describe('classifySfcChange with <style> blocks', () => {
	const withStyle = (style: string) => `<template><StackLayout><slot /></StackLayout></template>\n<script setup lang="ts">const color = 'red';</script>\n${style}`;

	async function classifyEdit(before: string, after: string): Promise<string> {
		const store: SfcSignatureStore = new Map();
		await classifySfcChange(FILE, withStyle(before), FILE, store);
		return classifySfcChange(FILE, withStyle(after), FILE, store);
	}

	it('is render-only when only the content of a plain or scoped block changed', async () => {
		expect(await classifyEdit('<style scoped>.a { color: red; }</style>', '<style scoped>.a { color: blue; }</style>')).toBe('render-only');
		expect(await classifyEdit('<style lang="scss">.a { color: red; }</style>', '<style lang="scss">.a { .b { color: blue; } }</style>')).toBe('render-only');
	});

	it('is full when the component gains or loses its scoped styles', async () => {
		expect(await classifyEdit('<style>.a { color: red; }</style>', '<style scoped>.a { color: red; }</style>')).toBe('full');
		expect(await classifyEdit('<style scoped>.a { color: red; }</style>', '<style>.a { color: red; }</style>')).toBe('full');
		expect(await classifyEdit('', '<style scoped>.a { color: red; }</style>')).toBe('full');
	});

	it('is full when a v-bind() is added or changed, render-only for other edits around it', async () => {
		expect(await classifyEdit('<style>.a { color: red; }</style>', '<style>.a { color: v-bind(color); }</style>')).toBe('full');
		expect(await classifyEdit('<style>.a { color: v-bind(color); }</style>', '<style>.a { background-color: v-bind(color); }</style>')).toBe('render-only');
	});

	it('is full when a <style module> block is added or changes its name or content', async () => {
		expect(await classifyEdit('<style>.a { color: red; }</style>', '<style module>.a { color: red; }</style>')).toBe('full');
		expect(await classifyEdit('<style module>.a { color: red; }</style>', '<style module>.b { color: red; }</style>')).toBe('full');
		expect(await classifyEdit('<style module>.a { color: red; }</style>', '<style module="classes">.a { color: red; }</style>')).toBe('full');
	});

	it('is full when the first :slotted() rule of a scoped block is added or the last removed', async () => {
		const own = '.own { color: red; }';
		expect(await classifyEdit(`<style scoped>${own}</style>`, `<style scoped>${own} :slotted(.item) { color: blue; }</style>`)).toBe('full');
		expect(await classifyEdit(`<style scoped>${own}</style>`, `<style scoped>${own} ::v-slotted(.item) { color: blue; }</style>`)).toBe('full');
		expect(await classifyEdit(`<style scoped>${own} :slotted(.item) { color: blue; }</style>`, `<style scoped>${own}</style>`)).toBe('full');
	});

	it('is render-only when an existing :slotted() rule is edited', async () => {
		expect(await classifyEdit('<style scoped>:slotted(.item) { color: blue; }</style>', '<style scoped>:slotted(.item) { color: green; }</style>')).toBe('render-only');
	});

	it('is render-only when :slotted() is added to an unscoped block', async () => {
		expect(await classifyEdit('<style>.own { color: red; }</style>', '<style>.own { color: red; } :slotted(.item) { color: blue; }</style>')).toBe('render-only');
	});

	it('is render-only when a block is added or its lang changes without touching the definition', async () => {
		expect(await classifyEdit('', '<style>.a { color: red; }</style>')).toBe('render-only');
		expect(await classifyEdit('<style scoped>.a { color: red; }</style>', '<style scoped>.a { color: red; }</style>\n<style scoped>.b { color: red; }</style>')).toBe('render-only');
		expect(await classifyEdit('<style>.a { color: red; }</style>', '<style lang="scss">.a { color: red; }</style>')).toBe('render-only');
	});
});

describe('seedSfcSignature', () => {
	it('lets the first edit of a session be classified', async () => {
		const store: SfcSignatureStore = new Map();
		await seedSfcSignature(FILE, sfc({ template: '<Label text="a" />', scriptSetup: 'const x = 1;' }), FILE, store);
		expect(await classifySfcChange(FILE, sfc({ template: '<Label text="b" />', scriptSetup: 'const x = 1;' }), FILE, store)).toBe('render-only');
	});

	it('never overwrites a signature recorded by a live edit', async () => {
		const store: SfcSignatureStore = new Map();
		await classifySfcChange(FILE, sfc({ template: '<Label />', scriptSetup: 'const edited = 1;' }), FILE, store);
		const afterEdit = store.get(FILE);
		await seedSfcSignature(FILE, sfc({ template: '<Label />', scriptSetup: 'const stale = 1;' }), FILE, store);
		expect(store.get(FILE)).toBe(afterEdit);
	});

	it('records nothing for a source it cannot parse', async () => {
		const store: SfcSignatureStore = new Map();
		await seedSfcSignature(FILE, '<template><Label></template', FILE, store);
		expect(store.has(FILE)).toBe(false);
	});
});
