import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./css-handler.js', () => ({ applyCssText: vi.fn() }));
vi.mock('./ws-transport.js', () => ({ connectHmr: vi.fn(), setHmrMessageHandler: vi.fn() }));
vi.mock('./protocol-dispatch.js', () => ({ handleHmrMessage: vi.fn() }));
vi.mock('./root-reset.js', () => ({ ensureCoreAliasesOnGlobalThis: vi.fn(), performResetRoot: vi.fn() }));
vi.mock('./strategy-loader.js', () => ({ CLIENT_STRATEGY_READY: Promise.resolve(), getClientStrategy: vi.fn() }));
vi.mock('../shared/runtime/launch-bridge.js', () => ({ installLaunchNotificationBridge: vi.fn(() => true) }));

import { applyCssText } from './css-handler.js';
import { getGlobalScope } from '../shared/runtime/global-scope.js';

describe('HMR client CSS register', () => {
	beforeAll(async () => {
		delete getGlobalScope().__NS_REGISTER_CSS__;
		getGlobalScope().__NS_PENDING_CSS__ = { 'sfc:/src/Queued.vue': '' };
		await import('./index.js');
	});

	afterAll(() => {
		delete getGlobalScope().__NS_REGISTER_CSS__;
		delete (getGlobalScope() as any).__NS_DEV_INSTALL_LAUNCH_BRIDGE__;
	});

	it('drains queued css, an empty unregister included', () => {
		expect(applyCssText).toHaveBeenCalledWith('', 'sfc:/src/Queued.vue');
		expect(getGlobalScope().__NS_PENDING_CSS__).toBeNull();
	});

	it('passes css and the empty unregister string to the applier', () => {
		const register = getGlobalScope().__NS_REGISTER_CSS__!;
		register('sfc:/src/App.vue', '.a { color: red; }');
		register('sfc:/src/App.vue', '');
		expect(applyCssText).toHaveBeenCalledWith('.a { color: red; }', 'sfc:/src/App.vue');
		expect(applyCssText).toHaveBeenLastCalledWith('', 'sfc:/src/App.vue');
	});

	it('ignores a non-string css value', () => {
		vi.mocked(applyCssText).mockClear();
		getGlobalScope().__NS_REGISTER_CSS__!('sfc:/src/App.vue', undefined as any);
		expect(applyCssText).not.toHaveBeenCalled();
	});
});
