import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import * as path from 'path';
import os from 'os';

import { registerSfcMetaRoute } from './sfc-route-meta.js';

type Transform = (id: string) => Promise<{ code: string } | null>;

describe('registerSfcMetaRoute <style> metadata', () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'sfc-meta-'));
		mkdirSync(path.join(root, 'src'));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function meta(file: string, source: string | null, transform: Transform) {
		if (source !== null) writeFileSync(path.join(root, 'src', file), source);
		let handler: any;
		const server = { middlewares: { use: (fn: any) => (handler = fn) }, transformRequest: vi.fn(transform), config: { root } };
		registerSfcMetaRoute(server as any, { verbose: false, appVirtualWithSlash: '/src/', sfcFileMap: new Map(), depFileMap: new Map(), getStrategy: () => ({}) as any });
		const res = {
			statusCode: 0,
			body: '',
			setHeader() {},
			end(body?: string) {
				this.body = body ?? '';
			},
		};
		await handler({ url: `/ns/sfc-meta?path=${encodeURIComponent(`/src/${file}`)}` }, res, vi.fn());
		return { statusCode: res.statusCode, payload: JSON.parse(res.body) };
	}

	const variants: Transform = async (id) => {
		if (id.includes('type=template')) return { code: 'export function render(_ctx, _cache) {}' };
		if (id.includes('type=script')) return { code: 'export default {}' };
		return { code: '_sfc_main.__hmrId = "7ba5bd90";' };
	};

	it('reports the style blocks and the descriptor id', async () => {
		const source = ['<template><StackLayout><slot /></StackLayout></template>', '<script setup>\nconst color = "red";\n</script>', '<style scoped>\n.own { color: v-bind(color); }\n:slotted(.item) { color: blue; }\n</style>', '<style module>\n.box { color: red; }\n</style>', '<style src="./external.css"></style>', '<style></style>'].join('\n');
		const { statusCode, payload } = await meta('Styled.vue', source, variants);

		expect(statusCode).toBe(200);
		expect(payload).toMatchObject({ hasStyle: true, styleCount: 3, scoped: true, slotted: true, cssModules: true, cssVars: ['color'], scopeId: '7ba5bd90' });
	});

	it('reports slotted only for :slotted() in a scoped block', async () => {
		const { payload } = await meta('UnscopedSlotted.vue', '<template><StackLayout><slot /></StackLayout></template>\n<style>\n:slotted(.item) { color: blue; }\n</style>\n', variants);
		expect(payload).toMatchObject({ hasStyle: true, scoped: false, slotted: false, cssModules: false, cssVars: [] });
	});

	it('reports no styles for an SFC without <style>', async () => {
		const { payload } = await meta('Plain.vue', '<template><Label text="a" /></template>\n', variants);
		expect(payload).toMatchObject({ hasStyle: false, styleCount: 0, scoped: false, slotted: false, cssModules: false, cssVars: [], scopeId: '7ba5bd90' });
	});

	it('answers hasScript: false instead of failing when a variant transform throws', async () => {
		const { statusCode, payload } = await meta('NoScript.vue', '<template><Label text="a" /></template>\n<style>\n.a { color: red; }\n</style>\n', async (id) => {
			if (id.includes('type=script')) throw new Error('no script block');
			return variants(id);
		});
		expect(statusCode).toBe(200);
		expect(payload).toMatchObject({ hasScript: false, hasTemplate: true, templateHasRender: true, hasStyle: true });
	});

	it('keeps the defaults when the SFC cannot be read', async () => {
		const { statusCode, payload } = await meta('Missing.vue', null, variants);
		expect(statusCode).toBe(200);
		expect(payload).toMatchObject({ hasScript: true, hasStyle: false, styleCount: 0, scopeId: null });
	});
});
