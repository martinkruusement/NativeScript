import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import { setProjectFlavor } from '../../helpers/flavor.js';
import { getProjectAppPath } from '../../helpers/utils.js';
import { getHMRPlugins } from './index.js';

describe('HMR boot recording', () => {
	let root: string;
	let server: ViteDevServer;
	let httpServer: Server;

	afterEach(async () => {
		await new Promise((resolve) => httpServer.close(resolve));
		await server.close();
		rmSync(root, { recursive: true, force: true });
	});

	it('records a boot whose session request is answered by ns-hmr-client', async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-hmr-boot-recording-')));
		const appDir = join(root, getProjectAppPath());
		mkdirSync(appDir, { recursive: true });
		const modules = Array.from({ length: 5 }, (_, i) => `probe-${i}.ts`);
		for (const name of modules) writeFileSync(join(appDir, name), `export const value = '${name}';\n`);
		setProjectFlavor('typescript');

		server = await createServer({
			root,
			configFile: false,
			logLevel: 'silent',
			server: { port: 0, hmr: false },
			plugins: getHMRPlugins({ platform: 'ios', flavor: 'typescript', verbose: false }),
		});
		httpServer = createHttpServer(server.middlewares);
		await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
		const fetchStatus = async (url: string) => {
			const response = await fetch(origin + url);
			await response.text();
			return response.status;
		};

		expect(await fetchStatus('/__ns_dev__/session')).toBe(200);
		const moduleUrls = modules.map((name) => `/ns/m/${getProjectAppPath()}/${name}`);
		for (const url of moduleUrls) expect(await fetchStatus(url)).toBe(200);
		// The next boot signal closes and persists the open window.
		expect(await fetchStatus('/__ns_dev__/session')).toBe(200);

		const recordingDir = join(root, 'node_modules', '.ns-vite');
		const recordings = existsSync(recordingDir) ? readdirSync(recordingDir).filter((file) => file.startsWith('boot-closure-')) : [];
		expect(recordings).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(recordingDir, recordings[0]), 'utf-8')).paths).toEqual(moduleUrls);
	});
});
