import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import * as path from 'path';
import os from 'os';

vi.mock('../../../server/websocket-device-transform.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../server/websocket-device-transform.js')>();
	return { ...actual, processCodeForDevice: vi.fn(actual.processCodeForDevice) };
});

import { processCodeForDevice } from '../../../server/websocket-device-transform.js';
import { registerSfcAsmRoute } from './sfc-route-assemble.js';

const ID = '5c0ffee5';

type Transform = (id: string) => Promise<{ code: string } | null>;

function makeRes() {
	return {
		statusCode: 0,
		body: '',
		setHeader() {},
		end(body?: string) {
			this.body = body ?? '';
		},
	};
}

// The css an assembled module registers under `sfc:<base>`, or null without a register call.
function registeredCss(code: string, base: string): string | null {
	const match = new RegExp(`var __t=${JSON.stringify('sfc:' + base).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')};var __c=("(?:[^"\\\\]|\\\\.)*");`).exec(code);
	return match ? JSON.parse(match[1]) : null;
}

function renderSlotCalls(code: string): string[] {
	return [...code.matchAll(/_renderSlot\(([^)]*)\)/g)].map((m) => m[1]);
}

describe('registerSfcAsmRoute <style> support', () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'sfc-asm-'));
		mkdirSync(path.join(root, 'src'));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// Each test assembles its own file: the assembler caches on path + source.
	async function assemble(file: string, source: string, options: { transform?: Transform; isProduction?: boolean } = {}) {
		const base = `/src/${file}`;
		writeFileSync(path.join(root, 'src', file), source);
		let handler: any;
		const mainTransform: Transform = async (id) => (id === base ? { code: `const _sfc_main = {};\n_sfc_main.__hmrId = "${ID}";` } : null);
		const server = {
			middlewares: { use: (fn: any) => (handler = fn) },
			transformRequest: vi.fn(options.transform ?? mainTransform),
			config: { root, isProduction: !!options.isProduction, server: {} },
		};
		registerSfcAsmRoute(server as any, { verbose: false, appVirtualWithSlash: '/src/', sfcFileMap: new Map(), depFileMap: new Map(), getStrategy: () => ({}) as any });
		const res = makeRes();
		await handler({ url: `/ns/asm?path=${encodeURIComponent(base)}` }, res, vi.fn());
		expect(res.statusCode).toBe(200);
		return { code: res.body, base, server };
	}

	it("runs plugin-vue's main transform on the bare path", async () => {
		const { server, base } = await assemble('Main.vue', '<template><Label text="a" /></template>\n<script setup>\nconst a = 1;\n</script>\n');
		const urls = server.transformRequest.mock.calls.map(([url]) => url);
		expect(urls).toContain(base);
		expect(urls).not.toContain(`${base}?vue`);
	});

	it('registers scoped css and attaches the matching __scopeId', async () => {
		const { code, base } = await assemble('Scoped.vue', '<template><StackLayout><Label class="own" text="a" /></StackLayout></template>\n<script setup>\nconst a = 1;\n</script>\n<style scoped>\n.own { color: red; }\n</style>\n');
		expect(registeredCss(code, base)).toContain(`.own[data-v-${ID}]`);
		expect(code).toContain(`__ns_sfc__["__scopeId"] = "data-v-${ID}";`);
	});

	it('compiles the template of a scoped SFC that uses :slotted() so slot content gets stamped', async () => {
		const { code, base } = await assemble('Slotted.vue', '<template><StackLayout><slot /><slot name="extra"><Label text="fallback" /></slot></StackLayout></template>\n<script setup>\nconst a = 1;\n</script>\n<style scoped>\n.own { color: red; }\n:slotted(.item) { color: blue; }\n</style>\n');
		const calls = renderSlotCalls(code);
		expect(calls).toHaveLength(2);
		for (const args of calls) expect(args).not.toMatch(/,\s*true\s*$/);
		expect(registeredCss(code, base)).toContain(`.item[data-v-${ID}-s]`);
	});

	it('passes noSlotted to renderSlot for a scoped SFC without :slotted()', async () => {
		const { code } = await assemble('NoSlotted.vue', '<template><StackLayout><slot /></StackLayout></template>\n<script setup>\nconst a = 1;\n</script>\n<style scoped>\n.own { color: red; }\n</style>\n');
		const calls = renderSlotCalls(code);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/,\s*true\s*$/);
	});

	it('leaves an unscoped SFC without __scopeId or noSlotted', async () => {
		const { code, base } = await assemble('Unscoped.vue', '<template><StackLayout><slot /></StackLayout></template>\n<script setup>\nconst a = 1;\n</script>\n<style>\n.plain { color: red; }\n</style>\n');
		expect(code).not.toContain('__scopeId');
		expect(renderSlotCalls(code)[0]).not.toMatch(/,\s*true\s*$/);
		expect(registeredCss(code, base)).toContain('.plain {');
	});

	it('attaches the class map of <style module> blocks as __cssModules', async () => {
		const { code, base } = await assemble('Module.vue', '<template><Label :class="$style.box" text="a" /></template>\n<script setup>\nconst a = 1;\n</script>\n<style module>\n.box { color: red; }\n</style>\n');
		const map = JSON.parse(/__ns_sfc__\["__cssModules"\] = (\{.*?\});/.exec(code)![1]);
		expect(Object.keys(map)).toEqual(['$style']);
		expect(registeredCss(code, base)).toContain(`.${map.$style.box}`);
	});

	it('names v-bind() variables the same in the css and the useCssVars call, in production too', async () => {
		for (const [file, isProduction] of [
			['VarsDev.vue', false],
			['VarsProd.vue', true],
		] as const) {
			const source = '<template><Label class="a" text="a" /></template>\n<script setup>\nconst color = \'red\';\n</script>\n<style scoped>\n.a { color: v-bind(color); }\n</style>\n';
			const { code, base } = await assemble(file, source, { transform: async () => null, isProduction });
			const name = /var\(--([\w-]+)\)/.exec(registeredCss(code, base)!)![1];
			expect(code).toContain(`"${name}"`);
			const rel = `src/${file}`;
			const id = createHash('sha256')
				.update(isProduction ? rel + source : rel)
				.digest('hex')
				.slice(0, 8);
			expect(code).toContain(`__ns_sfc__["__scopeId"] = "data-v-${id}";`);
		}
	});

	it('registers an empty stylesheet for an SFC without styles', async () => {
		const { code, base } = await assemble('NoStyle.vue', '<template><Label text="a" /></template>\n<script setup>\nconst a = 1;\n</script>\n');
		expect(registeredCss(code, base)).toBe('');
	});

	it('registers an empty stylesheet when the styles compile to nothing', async () => {
		const emptyPipeline: Transform = async (id) => (id.includes('type=style') ? { code: 'export default ""' } : null);
		const { code, base } = await assemble('VarsOnly.vue', '<template><Label text="a" /></template>\n<script setup>\nconst a = 1;\n</script>\n<style lang="scss">\n$c: red;\n</style>\n', { transform: emptyPipeline });
		expect(registeredCss(code, base)).toBe('');
	});

	it('registers app urls rebased by the Vite pipeline as ~/ urls', async () => {
		const pipeline: Transform = async (id) => (id.includes('type=style') ? { code: `export default ${JSON.stringify('.bg { background-image: url("/src/assets/bg.png"); }')}` } : null);
		const { code, base } = await assemble('Url.vue', '<template><Label class="bg" text="a" /></template>\n<script setup>\nconst a = 1;\n</script>\n<style>\n.bg { background-image: url("~/assets/bg.png"); }\n</style>\n', { transform: pipeline });
		expect(registeredCss(code, base)).toBe('.bg { background-image: url("~/assets/bg.png"); }');
	});

	it('attaches __scopeId and __cssModules and compiles the template scoped in the fallback emit path too', async () => {
		const scopedSource = (slot: string) => `<template><StackLayout :class="$style.box"><slot /></StackLayout></template>\n<script setup>\nconst a = 1;\n</script>\n<style scoped>\n.own { color: red; }\n${slot}</style>\n<style module>\n.box { color: red; }\n</style>\n`;
		for (const [file, slotRule, noSlotted] of [
			['FallbackSlotted.vue', ':slotted(.item) { color: blue; }\n', false],
			['FallbackScoped.vue', '', true],
		] as const) {
			vi.mocked(processCodeForDevice).mockImplementationOnce(() => {
				throw new Error('canonical path failed');
			});
			const { code, base } = await assemble(file, scopedSource(slotRule));
			expect(code).toContain(`// [sfc-asm] ${base} (inlined template`);
			expect(code).toContain(`__ns_sfc__["__scopeId"] = "data-v-${ID}";`);
			expect(code).toMatch(/__ns_sfc__\["__cssModules"\] = \{"\$style":\{"box":"[^"]+"\}\};/);
			expect(registeredCss(code, base)).toContain(`.own[data-v-${ID}]`);
			const calls = renderSlotCalls(code);
			expect(calls).toHaveLength(1);
			if (noSlotted) expect(calls[0]).toMatch(/,\s*true\s*$/);
			else expect(calls[0]).not.toMatch(/,\s*true\s*$/);
		}
	});

	it('registers nothing when every style block fails to compile, keeping the previous rules', async () => {
		const failing: Transform = async (id) => {
			if (id.includes('type=style')) throw new Error('syntax error');
			return null;
		};
		const { code, base } = await assemble('Broken.vue', '<template><Label text="a" /></template>\n<script setup>\nconst a = 1;\n</script>\n<style>\n.a { color: red;\n</style>\n', { transform: failing });
		expect(registeredCss(code, base)).toBeNull();
	});
});
