import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'fs';
import * as path from 'path';
import os from 'os';

import { canonicalizeNsMAppImports, compileSfcStyles, getSfcsDependingOnStylesheet, isProductionCompile, parse, resolveSfcDescriptorId } from './sfc-route-shared.js';

describe('canonicalizeNsMAppImports', () => {
	it('leaves canonical app-source static imports untouched', () => {
		const code = `import { b, c, dd } from "/ns/m/src/test2";`;
		expect(canonicalizeNsMAppImports(code)).toBe(code);
	});

	it('strips version tags from origin-prefixed, export-from, side-effect, and dynamic imports', () => {
		const code = ['import { a } from "http://localhost:5173/ns/m/__ns_hmr__/v7/src/test";', 'export * from "/ns/m/__ns_hmr__/v7/src/shared";', 'import "/ns/m/__ns_hmr__/v7/src/setup";', 'const m = await import("/ns/m/__ns_hmr__/v7/src/lazy");'].join('\n');
		const out = canonicalizeNsMAppImports(code);
		expect(out).toContain('"http://localhost:5173/ns/m/src/test"');
		expect(out).toContain('export * from "/ns/m/src/shared"');
		expect(out).toContain('import "/ns/m/src/setup"');
		expect(out).toContain('import("/ns/m/src/lazy")');
		expect(out).not.toContain('__ns_hmr__');
	});

	it('strips a stale version tag instead of preserving it', () => {
		const code = `import { b } from "/ns/m/__ns_hmr__/v2/src/test2";`;
		expect(canonicalizeNsMAppImports(code)).toBe(`import { b } from "/ns/m/src/test2";`);
	});

	it('leaves vendor imports untouched (stable module identity)', () => {
		const vendor = `import vue from "/ns/m/node_modules/nativescript-vue/dist/index.js";`;
		expect(canonicalizeNsMAppImports(vendor)).toBe(vendor);
	});

	it('leaves non-/ns/m imports untouched', () => {
		const code = `import { onMounted } from "/ns/rt";\nimport Comp from "/ns/asm/3?path=%2Fsrc%2FDetails.vue";`;
		expect(canonicalizeNsMAppImports(code)).toBe(code);
	});
});

describe('isProductionCompile', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("follows the dev server's resolved isProduction, as @vitejs/plugin-vue does", () => {
		vi.stubEnv('NODE_ENV', 'production');
		expect(isProductionCompile({ config: { isProduction: false } } as any)).toBe(false);
		vi.stubEnv('NODE_ENV', 'development');
		expect(isProductionCompile({ config: { isProduction: true } } as any)).toBe(true);
	});

	it('falls back to NODE_ENV without a resolved config', () => {
		vi.stubEnv('NODE_ENV', 'production');
		expect(isProductionCompile()).toBe(true);
		vi.stubEnv('NODE_ENV', 'development');
		expect(isProductionCompile()).toBe(false);
	});
});

describe('resolveSfcDescriptorId', () => {
	const root = '/project';
	const abs = '/project/src/components/Home.vue';
	const sha8 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8);

	it("reads the id from plugin-vue's main transform output", () => {
		const mainCode = 'const _sfc_main = {};\n_sfc_main.__hmrId = "7ba5bd90";\nimport "/src/components/Home.vue?vue&type=style&index=0&scoped=7ba5bd90&lang.css";';
		expect(resolveSfcDescriptorId({ server: { config: { root } } as any, abs, mainCode, source: '' })).toBe('7ba5bd90');
	});

	it('reads the id from a scoped style sub-request when there is no __hmrId', () => {
		const mainCode = 'import "/src/components/Home.vue?vue&type=style&index=0&scoped=0a1b2c3d&lang.css";';
		expect(resolveSfcDescriptorId({ server: { config: { root } } as any, abs, mainCode, source: '' })).toBe('0a1b2c3d');
	});

	it("otherwise hashes the root-relative path like plugin-vue's createDescriptor", () => {
		expect(resolveSfcDescriptorId({ server: { config: { root, isProduction: false } } as any, abs, source: '<template />' })).toBe(sha8('src/components/Home.vue'));
		expect(resolveSfcDescriptorId({ server: { config: { root, isProduction: false } } as any, abs, mainCode: 'export default {}', source: '<template />' })).toBe(sha8('src/components/Home.vue'));
	});

	it('adds the source to the hash in production', () => {
		expect(resolveSfcDescriptorId({ server: { config: { root, isProduction: true } } as any, abs, source: '<template />' })).toBe(sha8('src/components/Home.vue<template />'));
	});
});

describe('compileSfcStyles', () => {
	const ID = '7ba5bd91';
	let root: string;
	let outside: string;

	beforeAll(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'sfc-styles-'));
		mkdirSync(path.join(root, 'src', 'styles'), { recursive: true });
		writeFileSync(path.join(root, 'src', 'styles', 'external.css'), '.external { color: red; }');
		outside = mkdtempSync(path.join(os.tmpdir(), 'sfc-styles-outside-'));
		writeFileSync(path.join(outside, 'shared.css'), '.shared { color: red; }');
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	function compile(source: string, server?: any, extra: Record<string, unknown> = {}) {
		const abs = path.join(root, 'src', 'App.vue');
		const { descriptor } = parse(source, { filename: abs });
		return compileSfcStyles({ server, descriptor, base: '/src/App.vue', abs, projectRoot: root, appVirtualWithSlash: '/src/', scopeId: ID, ...extra });
	}

	function pipelineServer(css: (url: string) => string | null) {
		return {
			config: { root },
			transformRequest: vi.fn(async (url: string) => {
				const out = css(url);
				return out === null ? null : { code: `export default ${JSON.stringify(out)}` };
			}),
		};
	}

	it("compiles each block through the Vite pipeline with plugin-vue's sub-request plus &inline", async () => {
		const server = pipelineServer((url) => (url.includes('index=0') ? '.a[data-v-x] { color: red; }' : '.b { color: blue; }'));
		const result = await compile('<template><Label /></template>\n<style scoped>.a { color: red; }</style>\n<style lang="scss" data-x="1" flag>.b { color: blue; }</style>', server);

		expect(server.transformRequest.mock.calls.map(([url]) => url)).toEqual(['/src/App.vue?vue&type=style&index=0&inline&scoped=7ba5bd91&lang.css', '/src/App.vue?vue&type=style&index=1&inline&data-x=1&flag=true&lang.scss']);
		expect(result).toEqual({ css: '.a[data-v-x] { color: red; }\n.b { color: blue; }', cssModules: null, scopeId: ID, failed: false });
	});

	it('falls back to @vue/compiler-sfc when the pipeline fails, with scoping and v-bind() resolved', async () => {
		const server = { config: { root }, transformRequest: vi.fn(async () => Promise.reject(new Error('boom'))) };
		const result = await compile('<template><Label /></template>\n<style scoped>.a { color: v-bind(color); }\n:deep(.child) { color: red; }\n:global(.g) { color: red; }\n:slotted(.item) { color: red; }</style>', server);

		expect(server.transformRequest).toHaveBeenCalledTimes(1);
		expect(result.css).toContain(`.a[data-v-${ID}]`);
		expect(result.css).toContain(`var(--${ID}-color)`);
		expect(result.css).toContain(`[data-v-${ID}] .child`);
		expect(result.css).toContain('.g {');
		expect(result.css).toContain(`.item[data-v-${ID}-s]`);
	});

	it('falls back when the pipeline answers something other than inline css', async () => {
		const result = await compile('<template><Label /></template>\n<style scoped>.a { color: red; }</style>', { config: { root }, transformRequest: vi.fn(async () => ({ code: 'import "x"; export {}' })) });
		expect(result.css).toContain(`.a[data-v-${ID}]`);
	});

	it('compiles directly without a dev server, preprocessors included', async () => {
		const result = await compile('<template><Label /></template>\n<style lang="scss">$c: #123456; .s { .n { color: $c; } }</style>', undefined, { projectRoot: import.meta.dirname });
		expect(result.css).toMatch(/\.s \.n \{\s*color: #123456;\s*\}/);
	});

	it('compiles <style module> blocks directly so css and class map agree', async () => {
		const server = { config: { root, css: { modules: { generateScopedName: '[local]_hashed' } } }, transformRequest: vi.fn() };
		const result = await compile('<template><Label /></template>\n<style module>.box { color: red; }</style>\n<style module="named">.row { color: blue; }</style>', server);

		expect(server.transformRequest).not.toHaveBeenCalled();
		expect(result.cssModules).toEqual({ $style: { box: 'box_hashed' }, named: { row: 'row_hashed' } });
		expect(result.css).toContain('.box_hashed');
		expect(result.css).toContain('.row_hashed');
	});

	it('requests a <style src> block under the stylesheet path and reads the file for the fallback', async () => {
		const server = { config: { root }, transformRequest: vi.fn(async (_url: string) => null) };
		const result = await compile('<template><Label /></template>\n<style scoped src="./styles/external.css"></style>\n<style src="./styles/external.css"></style>', server);

		expect(server.transformRequest.mock.calls.map(([url]) => url)).toEqual(['/src/styles/external.css?vue&type=style&index=0&src=7ba5bd91&inline&scoped=7ba5bd91&lang.css', '/src/styles/external.css?vue&type=style&index=1&src=true&inline&lang.css']);
		expect(result.css).toContain(`.external[data-v-${ID}]`);
		expect(result.css).toContain('.external {');
	});

	it('resolves <style src> with the dev server resolver, aliases and root-relative paths included', async () => {
		const external = path.join(root, 'src', 'styles', 'external.css');
		const resolveId = vi.fn(async (id: string) => (id === '~/styles/external.css' || id === '/src/styles/external.css' ? { id: external } : null));
		const server = { config: { root }, pluginContainer: { resolveId }, transformRequest: vi.fn(async (_url: string) => null) };
		const result = await compile('<template><Label /></template>\n<style src="~/styles/external.css"></style>\n<style scoped src="/src/styles/external.css"></style>', server);

		expect(resolveId).toHaveBeenCalledWith('~/styles/external.css', path.join(root, 'src', 'App.vue'));
		expect(server.transformRequest.mock.calls.map(([url]) => url)).toEqual(['/src/styles/external.css?vue&type=style&index=0&src=true&inline&lang.css', '/src/styles/external.css?vue&type=style&index=1&src=7ba5bd91&inline&scoped=7ba5bd91&lang.css']);
		expect(result.css).toContain('.external {');
		expect(result.css).toContain(`.external[data-v-${ID}]`);
		expect(result.failed).toBe(false);
	});

	it('requests a <style src> block outside the root under /@fs/', async () => {
		const shared = path.join(outside, 'shared.css');
		const server = { config: { root }, pluginContainer: { resolveId: vi.fn(async () => ({ id: shared })) }, transformRequest: vi.fn(async (_url: string) => null) };
		const result = await compile('<template><Label /></template>\n<style src="shared-styles/shared.css"></style>', server);

		expect(server.transformRequest.mock.calls[0][0]).toBe(`/@fs/${shared.split(path.sep).join('/').replace(/^\/+/, '')}?vue&type=style&index=0&src=true&inline&lang.css`);
		expect(result.css).toContain('.shared {');
	});

	it('skips a <style src> block whose file cannot be read and empty blocks, reporting the failure', async () => {
		const server = pipelineServer(() => '.kept { color: red; }');
		const result = await compile('<template><Label /></template>\n<style src="./missing.css"></style>\n<style>  </style>\n<style>.kept { color: red; }</style>', server);

		expect(server.transformRequest).toHaveBeenCalledTimes(1);
		expect(result.css).toBe('.kept { color: red; }');
		expect(result.failed).toBe(true);
	});

	it('reports a block that fails in the pipeline and in the direct compile', async () => {
		const server = { config: { root }, transformRequest: vi.fn(async () => Promise.reject(new Error('syntax error'))) };
		const result = await compile('<template><Label /></template>\n<style>.a { color: red;</style>', server);
		expect(result.failed).toBe(true);
	});

	it('does not report a block that compiles to nothing as failed', async () => {
		const result = await compile('<template><Label /></template>\n<style lang="scss">$c: red;</style>', undefined, { projectRoot: import.meta.dirname });
		expect(result).toMatchObject({ css: '', failed: false });
	});

	it("gives the dev-server urls of app files back as ~/ urls, the device's app root", async () => {
		const server = pipelineServer(() => [".a { background-image: url('/src/assets/x.png'); }", '.b { background: url(/src/assets/big.png) no-repeat; }', '.c { background-image: url("/src/components/y.png?t=1700000000000"); }', ".d { background-image: url('res://icon'); }", ".e { background-image: url('/node_modules/pkg/a.png'); }", '.f { background-image: url("data:image/png;base64,iVBORw=="); }', ".g { background-image: url('https://example.com/src/a.png'); }"].join('\n'));
		const result = await compile("<template><Label /></template>\n<style>.a { background-image: url('~/assets/x.png'); }</style>", server);

		expect(result.css).toContain("url('~/assets/x.png')");
		expect(result.css).toContain('url(~/assets/big.png) no-repeat');
		expect(result.css).toContain('url("~/components/y.png")');
		expect(result.css).toContain("url('res://icon')");
		expect(result.css).toContain("url('/node_modules/pkg/a.png')");
		expect(result.css).toContain('url("data:image/png;base64,iVBORw==")');
		expect(result.css).toContain("url('https://example.com/src/a.png')");
	});

	it("follows the dev server's base and origin when restoring app urls", async () => {
		const server = { ...pipelineServer(() => '.a { background-image: url(http://10.0.2.2:5173/base/src/assets/x.png); }'), config: { root, base: '/base/', server: { origin: 'http://10.0.2.2:5173' } } };
		const result = await compile("<template><Label /></template>\n<style>.a { background-image: url('~/assets/x.png'); }</style>", server);
		expect(result.css).toContain('url(~/assets/x.png)');
	});

	it('keeps the urls of a direct compile as written', async () => {
		const server = { config: { root }, transformRequest: vi.fn(async () => Promise.reject(new Error('boom'))) };
		const result = await compile("<template><Label /></template>\n<style>.a { background-image: url('~/assets/x.png'); }\n.b { background-image: url('/src/assets/x.png'); }</style>", server);
		expect(result.css).toContain("url('~/assets/x.png')");
		expect(result.css).toContain("url('/src/assets/x.png')");
	});

	it('compiles only the requested block with onlyIndex', async () => {
		const server = pipelineServer((url) => `/* ${url.match(/index=\d/)![0]} */`);
		const result = await compile('<template><Label /></template>\n<style>.a { color: red; }</style>\n<style>.b { color: red; }</style>', server, { onlyIndex: 1 });
		expect(result.css).toBe('/* index=1 */');
	});

	it('renames digit-terminated scoped keyframes and strips @charset', async () => {
		const server = pipelineServer(() => `@charset "UTF-8";\n@keyframes spin-${ID} { to { opacity: 1; } }\n.a[data-v-${ID}] { animation: spin-${ID} 1s infinite; }`);
		const result = await compile('<template><Label /></template>\n<style scoped>.a { animation: spin 1s infinite; }</style>', server);

		expect(result.css).not.toContain('@charset');
		expect(result.css).toContain(`@keyframes spin-${ID}x`);
		expect(result.css).toContain(`animation: spin-${ID}x 1s infinite`);
	});

	it('returns empty css for an SFC without styles', async () => {
		expect(
			await compile(
				'<template><Label /></template>',
				pipelineServer(() => ''),
			),
		).toEqual({ css: '', cssModules: null, scopeId: ID, failed: false });
	});

	it('resolves the scope id when none is given', async () => {
		const abs = path.join(root, 'src', 'App.vue');
		const { descriptor } = parse('<template><Label /></template>\n<style scoped>.a { color: red; }</style>', { filename: abs });
		const result = await compileSfcStyles({ descriptor, base: '/src/App.vue', abs, projectRoot: root, appVirtualWithSlash: '/src/', mainCode: '_sfc_main.__hmrId = "0f0f0f0f"' });
		expect(result.scopeId).toBe('0f0f0f0f');
		expect(result.css).toContain('.a[data-v-0f0f0f0f]');
	});
});

describe('getSfcsDependingOnStylesheet', () => {
	let root: string;
	let stylesDir: string;

	beforeAll(() => {
		root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sfc-style-deps-')));
		stylesDir = path.join(root, 'src', 'styles');
		mkdirSync(stylesDir, { recursive: true });
		writeFileSync(path.join(stylesDir, 'card.css'), '.card { color: red; }');
		writeFileSync(path.join(stylesDir, '_colors.scss'), '$accent: #123456;');
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function compile(base: string, source: string, server?: any, projectRoot = root) {
		const abs = path.join(root, base.replace(/^\//, ''));
		const { descriptor } = parse(source, { filename: abs });
		return compileSfcStyles({ server, descriptor, base, abs, projectRoot, appVirtualWithSlash: '/src/', scopeId: '7ba5bd91' });
	}

	it('records the file of a <style src> block, also before the file exists', async () => {
		await compile('/src/SrcDep.vue', '<template><Label /></template>\n<style scoped src="./styles/card.css"></style>\n<style src="./styles/later.css"></style>');

		expect(getSfcsDependingOnStylesheet(path.join(stylesDir, 'card.css'))).toEqual(['/src/SrcDep.vue']);
		expect(getSfcsDependingOnStylesheet(path.join(stylesDir, 'later.css'))).toEqual(['/src/SrcDep.vue']);
	});

	it('records the files the Vite pipeline read for a block', async () => {
		const getModuleByUrl = vi.fn(async () => ({ importedModules: new Set([{ file: path.join(stylesDir, '_theme.css') }, { file: null }]) }));
		const server = { config: { root }, moduleGraph: { getModuleByUrl }, transformRequest: vi.fn(async () => ({ code: 'export default ".a { color: red; }"' })) };
		await compile('/src/ViteDep.vue', "<template><Label /></template>\n<style>@import './styles/_theme.css';</style>", server);

		expect(getModuleByUrl).toHaveBeenCalledWith('/src/ViteDep.vue?vue&type=style&index=0&inline&lang.css');
		expect(getSfcsDependingOnStylesheet(path.join(stylesDir, '_theme.css'))).toEqual(['/src/ViteDep.vue']);
	});

	it("reads the client environment's module graph when there is one", async () => {
		const legacy = vi.fn(async () => undefined);
		const client = vi.fn(async () => ({ importedModules: new Set([{ file: path.join(stylesDir, '_client.css') }]) }));
		const server = { config: { root }, environments: { client: { moduleGraph: { getModuleByUrl: client } } }, moduleGraph: { getModuleByUrl: legacy }, transformRequest: vi.fn(async () => ({ code: 'export default ""' })) };
		await compile('/src/ClientDep.vue', '<template><Label /></template>\n<style>.a { color: red; }</style>', server);

		expect(legacy).not.toHaveBeenCalled();
		expect(getSfcsDependingOnStylesheet(path.join(stylesDir, '_client.css'))).toEqual(['/src/ClientDep.vue']);
	});

	it('records the sass partials of a direct compile', async () => {
		const result = await compile('/src/SassDep.vue', '<template><Label /></template>\n<style lang="scss">@use \'./styles/colors\' as c;\n.a { color: c.$accent; }</style>', undefined, import.meta.dirname);

		expect(result.css).toContain('#123456');
		expect(getSfcsDependingOnStylesheet(path.join(stylesDir, '_colors.scss'))).toEqual(['/src/SassDep.vue']);
	});

	it('keeps compiling when the module graph lookup fails', async () => {
		const server = { config: { root }, moduleGraph: { getModuleByUrl: vi.fn(async () => Promise.reject(new Error('boom'))) }, transformRequest: vi.fn(async () => ({ code: 'export default ".kept { color: red; }"' })) };
		const result = await compile('/src/GraphFails.vue', '<template><Label /></template>\n<style>.kept { color: red; }</style>', server);

		expect(result).toMatchObject({ css: '.kept { color: red; }', failed: false });
	});

	it('lists every SFC that depends on a stylesheet, for any spelling of its path', async () => {
		await compile('/src/A.vue', '<template><Label /></template>\n<style src="./styles/shared.css"></style>');
		await compile('/src/B.vue', '<template><Label /></template>\n<style scoped src="./styles/shared.css"></style>');

		expect(getSfcsDependingOnStylesheet(path.join(stylesDir, '..', 'styles', 'shared.css'))).toEqual(['/src/A.vue', '/src/B.vue']);
		expect(getSfcsDependingOnStylesheet(path.join(stylesDir, 'unrelated.css'))).toEqual([]);
	});
});
