import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import * as path from 'path';
import os from 'os';

import { registerSfcServeRoute } from './sfc-route-serve.js';

describe('registerSfcServeRoute style variants', () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'sfc-serve-'));
		mkdirSync(path.join(root, 'src'));
		writeFileSync(path.join(root, 'src', 'App.vue'), '<template><Label class="a" text="a" /></template>\n<style>\n.a { color: red; }\n</style>\n<style scoped>\n.b { color: blue; }\n</style>\n');
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function serve(url: string) {
		let handler: any;
		const transformRequest = vi.fn(async (id: string) => {
			if (id === '/src/App.vue') return { code: '_sfc_main.__hmrId = "7ba5bd90";' };
			if (id.includes('type=style')) return { code: `export default ${JSON.stringify(`/* ${id} */`)}` };
			return null;
		});
		const server = { middlewares: { use: (fn: any) => (handler = fn) }, transformRequest, config: { root } };
		registerSfcServeRoute(server as any, { verbose: false, appVirtualWithSlash: '/src/', sfcFileMap: new Map(), depFileMap: new Map(), getStrategy: () => ({}) as any });
		const res = {
			statusCode: 0,
			body: '',
			setHeader() {},
			end(body?: string) {
				this.body = body ?? '';
			},
		};
		await handler({ url }, res, vi.fn());
		return { res, transformRequest };
	}

	it("serves the requested block's compiled css as the default export", async () => {
		const { res, transformRequest } = await serve('/ns/sfc/src/App.vue?vue&type=style&index=1&scoped=7ba5bd90&lang.css');

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('// [sfc] kind=variant:style path=/src/App.vue?vue&type=style&index=1&scoped=7ba5bd90&lang.css index=1 scoped=true scopeId=7ba5bd90');
		expect(res.body).toContain(`export default ${JSON.stringify('/* /src/App.vue?vue&type=style&index=1&inline&scoped=7ba5bd90&lang.css */')};`);
		expect(transformRequest.mock.calls.map(([id]) => id)).toEqual(['/src/App.vue', '/src/App.vue?vue&type=style&index=1&inline&scoped=7ba5bd90&lang.css']);
	});

	it('does not register the css on the device', async () => {
		const { res } = await serve('/ns/sfc/src/App.vue?vue&type=style&index=0&lang.css');
		expect(res.body).toContain('index=0 scoped=false');
		expect(res.body).not.toContain('__NS_REGISTER_CSS__');
	});

	it('serves an empty default export when the SFC cannot be read', async () => {
		const { res } = await serve('/ns/sfc/src/Missing.vue?vue&type=style&index=0&lang.css');
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('export default "";');
	});
});
