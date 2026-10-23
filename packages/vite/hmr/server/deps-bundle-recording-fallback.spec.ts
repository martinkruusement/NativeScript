import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { BuildOptions } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// esbuild 0.27.4 (the version this repo's lockfile pins) throws an uncaught
// error instead of rejecting when a build with `metafile: true` fails
// (evanw/esbuild#4420, fixed in 0.27.5), so these cases make a build reject
// through `rejectBuild` instead of handing esbuild an unbundleable file.
const esbuildState = vi.hoisted(() => ({ rejectBuild: null as ((options: BuildOptions) => boolean) | null, calls: 0 }));
vi.mock('esbuild', async (importOriginal) => {
	const actual = await importOriginal<typeof import('esbuild')>();
	return {
		...actual,
		build: (options: BuildOptions) => {
			esbuildState.calls++;
			if (esbuildState.rejectBuild?.(options)) return Promise.reject(new Error('Build failed with 1 error: Could not resolve "../../dist/types/index"'));
			return actual.build(options);
		},
	};
});

import { createDepsBundleService } from './deps-bundle.js';

const RECORDED_DEEP_FILE = '/ns/m/node_modules/pkg-deep/lib/deep.js';
const includesRecordedFile = (options: BuildOptions) => String(options.stdin?.contents ?? '').includes('pkg-deep');

describe('createDepsBundleService with a boot recording the bundle cannot take', () => {
	let projectRoot: string;
	let warn: MockInstance<typeof console.warn>;

	beforeEach(() => {
		projectRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'ns-deps-recording-fallback-'));
		const write = (rel: string, contents: string) => {
			mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
			writeFileSync(path.join(projectRoot, rel), contents);
		};
		write('package.json', JSON.stringify({ name: 'fixture-app', version: '1.0.0', dependencies: { 'nativescript-widgets': '1.0.0' } }));
		write('node_modules/nativescript-widgets/package.json', JSON.stringify({ name: 'nativescript-widgets', version: '1.0.0', main: 'index' }));
		write('node_modules/nativescript-widgets/index.ios.js', `export const Widget = 'ios-widget';\n`);
		write('node_modules/pkg-deep/package.json', JSON.stringify({ name: 'pkg-deep', version: '1.0.0', main: 'index.js' }));
		write('node_modules/pkg-deep/lib/deep.js', `export const deep = 1;\n`);
		esbuildState.calls = 0;
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		esbuildState.rejectBuild = null;
		warn.mockRestore();
		rmSync(projectRoot, { recursive: true, force: true });
	});

	const makeService = (recordedPaths: string[]) => createDepsBundleService({ projectRoot, platform: 'ios', mode: 'development', flavor: 'typescript', getRecordedPaths: () => recordedPaths });

	it('rebuilds from the vendor collection alone when the build with recorded entries fails', async () => {
		esbuildState.rejectBuild = includesRecordedFile;
		const service = makeService([RECORDED_DEEP_FILE]);
		const state = await service.ensureBuilt();
		expect(state).not.toBeNull();
		expect(service.hasFailed()).toBe(false);
		expect(state!.keys).toContain('node_modules/nativescript-widgets/index.ios.js');
		expect(state!.keys).not.toContain('node_modules/pkg-deep/lib/deep.js');
		expect(service.getShimForSpec('/node_modules/nativescript-widgets')).toContain('export const Widget = ');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('bundle build with the boot recording FAILED — retrying without it');
		expect(warn.mock.calls[0][0]).toContain('node_modules/.ns-vite/boot-closure-*.json');
	});

	it('falls back to per-module serving when the build without the recording fails too', async () => {
		esbuildState.rejectBuild = () => true;
		const service = makeService([RECORDED_DEEP_FILE]);
		expect(await service.ensureBuilt()).toBeNull();
		expect(service.hasFailed()).toBe(true);
		// One discovery pass per attempt: no retry loop.
		expect(esbuildState.calls).toBe(2);
		expect(warn.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining('with the boot recording FAILED'), expect.stringContaining('bundle build FAILED — falling back to per-module')]);
	});

	it('does not retry when the recording adds no bundle entries', async () => {
		esbuildState.rejectBuild = () => true;
		const service = makeService(['/ns/m/src/app.ts', '/ns/m/node_modules/@nativescript/core/index.js']);
		expect(await service.ensureBuilt()).toBeNull();
		expect(service.hasFailed()).toBe(true);
		expect(esbuildState.calls).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('bundle build FAILED — falling back to per-module');
	});
});
