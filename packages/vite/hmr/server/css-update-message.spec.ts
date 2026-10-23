import { afterEach, describe, expect, it, vi } from 'vitest';

import { appCssRootRelPath, buildCssUpdateItem, loadCssUpdateText } from './css-update-message.js';

describe('appCssRootRelPath', () => {
	it('returns the root-relative posix path with a leading slash', () => {
		expect(appCssRootRelPath('/proj', '/proj/src/app.css')).toBe('/src/app.css');
	});

	it('tolerates a trailing slash on root and Windows separators', () => {
		expect(appCssRootRelPath('/proj/', '/proj/src/app.css')).toBe('/src/app.css');
		expect(appCssRootRelPath('C:/proj', 'C:\\proj\\src\\app.css')).toBe('/src/app.css');
	});

	it('returns null when the stylesheet escapes the project root (a /../ fetch URL is unresolvable)', () => {
		expect(appCssRootRelPath('/proj', '/elsewhere/app.css')).toBeNull();
		expect(appCssRootRelPath('/proj', '/proj')).toBeNull();
	});
});

describe('buildCssUpdateItem', () => {
	it('omits the tag for global stylesheet updates and carries it for component updates', () => {
		expect(buildCssUpdateItem('/src/app.css', { timestamp: 1 })).toEqual({ type: 'css-update', path: '/src/app.css', acceptedPath: '/src/app.css', timestamp: 1 });
		expect(buildCssUpdateItem('/src/a.component.css', { tag: '/src/a.component.css', timestamp: 2 })).toEqual({
			type: 'css-update',
			path: '/src/a.component.css',
			acceptedPath: '/src/a.component.css',
			timestamp: 2,
			tag: '/src/a.component.css',
		});
	});

	it('carries cssText only when it is a string', () => {
		expect(buildCssUpdateItem('/src/app.css', { timestamp: 1, cssText: '.a { color: red; }' })).toEqual({ type: 'css-update', path: '/src/app.css', acceptedPath: '/src/app.css', timestamp: 1, cssText: '.a { color: red; }' });
		expect(buildCssUpdateItem('/src/app.css', { timestamp: 1, cssText: '' })).toHaveProperty('cssText', '');
		expect(buildCssUpdateItem('/src/app.css', { timestamp: 1, cssText: null })).not.toHaveProperty('cssText');
		expect(buildCssUpdateItem('/src/app.css', { timestamp: 1, cssText: undefined })).not.toHaveProperty('cssText');
	});
});

describe('loadCssUpdateText', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeServer(transform: (url: string) => unknown): any {
		return { transformRequest: vi.fn(async (url: string) => transform(url)) };
	}

	it('returns the ?direct transform output, normalized for the device', async () => {
		const server = makeServer((url) => (url === '/src/app.css?direct' ? { code: '\uFEFF@charset "UTF-8";\n.a { color: red; }' } : null));

		expect(await loadCssUpdateText(server, '/src/app.css')).toBe('.a { color: red; }');
		expect(server.transformRequest).toHaveBeenCalledTimes(1);
	});

	it('falls back to the ?inline module when the ?direct transform throws', async () => {
		const server = makeServer((url) => {
			if (url.endsWith('?direct')) throw new Error('boom');
			return { code: 'export default ".a { content: \\"x\\"; }"' };
		});

		expect(await loadCssUpdateText(server, '/src/app.css')).toBe('.a { content: "x"; }');
		expect(server.transformRequest).toHaveBeenLastCalledWith('/src/app.css?inline');
	});

	it('normalizes the ?inline fallback output for the device', async () => {
		const server = makeServer((url) => (url.endsWith('?direct') ? null : { code: `export default ${JSON.stringify('\uFEFF@charset "UTF-8";\n.a { color: red; }')}` }));

		expect(await loadCssUpdateText(server, '/src/app.css')).toBe('.a { color: red; }');
	});

	it('falls back to the ?inline module when ?direct yields a js module instead of css', async () => {
		const server = makeServer((url) => (url.endsWith('?direct') ? { code: 'import { updateStyle } from "/@vite/client";' } : { code: 'export default ".b { color: blue; }";' }));

		expect(await loadCssUpdateText(server, '/src/app.css')).toBe('.b { color: blue; }');
	});

	it('returns an empty string for an empty stylesheet', async () => {
		const server = makeServer((url) => (url.endsWith('?direct') ? { code: '' } : { code: 'export default ""' }));

		expect(await loadCssUpdateText(server, '/src/app.css')).toBe('');
	});

	it('returns null when neither transform yields css', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const throwing = makeServer(() => {
			throw new Error('boom');
		});
		const empty = makeServer(() => null);
		const unexpectedShape = makeServer(() => ({ code: 'export default __css' }));

		expect(await loadCssUpdateText(throwing, '/src/app.css')).toBeNull();
		expect(await loadCssUpdateText(empty, '/src/app.css')).toBeNull();
		expect(await loadCssUpdateText(unexpectedShape, '/src/app.css')).toBeNull();
		expect(await loadCssUpdateText({} as any, '/src/app.css')).toBeNull();
		expect(warn).not.toHaveBeenCalled();
	});

	it('logs transform failures when verbose', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const server = makeServer(() => {
			throw new Error('boom');
		});

		expect(await loadCssUpdateText(server, '/src/app.css', { verbose: true })).toBeNull();
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[0]).toEqual(['[hmr-ws] css ?direct transform failed for', '/src/app.css', 'boom']);
	});

	it('appends the query to a path that already has one', async () => {
		const server = makeServer(() => null);

		await loadCssUpdateText(server, '/src/app.css?v=1');

		expect(server.transformRequest.mock.calls.map((c: unknown[]) => c[0])).toEqual(['/src/app.css?v=1&direct', '/src/app.css?v=1&inline']);
	});
});
