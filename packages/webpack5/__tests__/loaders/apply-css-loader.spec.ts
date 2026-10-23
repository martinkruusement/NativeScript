import applyCssLoader from '../../src/loaders/apply-css-loader';
import * as hmrRuntime from '../../src/loaders/apply-css-loader/hmr.runtime';

const HMR_RUNTIME_PATH =
	require.resolve('../../src/loaders/apply-css-loader/hmr.runtime');
const STYLE_SCOPE = '@nativescript/core/ui/styling/style-scope';
const LOADERS_PATH = '/app/node_modules/@nativescript/webpack/dist/loaders';

type CssLoader = 'css2json-loader' | 'css-loader';

interface LoaderOptions {
	hot: boolean;
	mode: 'development' | 'production';
	loader: CssLoader;
	resourcePath?: string;
	content?: string;
}

function runLoader({
	hot,
	mode,
	loader,
	resourcePath = '/app/src/app.css',
	content = 'CONTENT',
}: LoaderOptions): string {
	let output: string;
	applyCssLoader.call(
		{
			hot,
			mode,
			resourcePath,
			loaderIndex: 0,
			loaders: [
				{ path: `${LOADERS_PATH}/apply-css-loader/index.js` },
				{ path: `${LOADERS_PATH}/${loader}/index.js` },
			],
			emitWarning: (error: Error) => {
				throw error;
			},
			callback: (_error: unknown, code: string) => {
				output = code;
			},
		},
		content,
		null,
	);
	return output;
}

// Models core's selector list: a tagged add appends, a tagged remove drops.
function createStyleScope() {
	const sheets: { tag: string; css: unknown }[] = [];
	return {
		sheets,
		addTaggedAdditionalCSS: jest.fn((css: unknown, tag: string) => {
			sheets.push({ tag, css });
			return true;
		}),
		removeTaggedAdditionalCSS: jest.fn((tag: string) => {
			const kept = sheets.filter((sheet) => sheet.tag !== tag);
			const removed = kept.length !== sheets.length;
			sheets.splice(0, sheets.length, ...kept);
			return removed;
		}),
	};
}

// Models webpack's HMR: dispose every updated module, then re-execute the kept ones.
function createApp() {
	const styleScope = createStyleScope();
	const disposeHandlers = new Map<string, (() => void)[]>();
	const hotObjects = new Map<string, { accept: jest.Mock }>();
	let status = 'idle';

	const fakeRequire = (request: string) => {
		if (request === HMR_RUNTIME_PATH) {
			return hmrRuntime;
		}
		if (request === STYLE_SCOPE) {
			return styleScope;
		}
		throw new Error(`unexpected require: ${request}`);
	};

	const execute = (id: string, code: string) => {
		const handlers: (() => void)[] = [];
		const hot = {
			accept: jest.fn(),
			dispose: (handler: () => void) => handlers.push(handler),
			status: () => status,
		};
		disposeHandlers.set(id, handlers);
		hotObjects.set(id, hot);
		new Function('module', 'require', code)({ id, hot }, fakeRequire);
	};

	const update = (modules: Record<string, string | null>) => {
		status = 'dispose';
		for (const id of Object.keys(modules)) {
			(disposeHandlers.get(id) || []).forEach((handler) => handler());
		}
		status = 'apply';
		for (const [id, code] of Object.entries(modules)) {
			if (code !== null) {
				execute(id, code);
			}
		}
		status = 'idle';
	};

	return { styleScope, hotObjects, execute, update };
}

function css2jsonModule(
	resourcePath: string,
	css: string,
	mode: LoaderOptions['mode'] = 'development',
): string {
	return runLoader({
		hot: true,
		mode,
		loader: 'css2json-loader',
		resourcePath,
		content: `const ___CSS2JSON_LOADER_EXPORT___ = ${JSON.stringify(css)};`,
	});
}

function cssLoaderModule(resourcePath: string, css: string[]): string {
	const cssExports = css.map((cssText, index) => [`${index}`, cssText, '']);
	return runLoader({
		hot: true,
		mode: 'development',
		loader: 'css-loader',
		resourcePath,
		content: `const ___CSS_LOADER_EXPORT___ = ${JSON.stringify(cssExports)};`,
	});
}

describe('apply-css-loader', () => {
	beforeEach(() => {
		delete (globalThis as any).__NS_WEBPACK_CSS_TAG_ORDER__;
	});

	describe('without HMR', () => {
		it('keeps the css2json-loader output of a development build', () => {
			expect(
				runLoader({
					hot: false,
					mode: 'development',
					loader: 'css2json-loader',
				}),
			).toBe(
				[
					'CONTENT',
					'const { addTaggedAdditionalCSS } = require("@nativescript/core/ui/styling/style-scope");',
					'addTaggedAdditionalCSS(___CSS2JSON_LOADER_EXPORT___, "/app/src/app.css")',
					'',
				].join('\n'),
			);
		});

		it('keeps the css2json-loader output of a production build', () => {
			expect(
				runLoader({
					hot: false,
					mode: 'production',
					loader: 'css2json-loader',
				}),
			).toBe(
				[
					'CONTENT',
					'const { addTaggedAdditionalCSS } = require("@nativescript/core/ui/styling/style-scope");',
					'addTaggedAdditionalCSS(___CSS2JSON_LOADER_EXPORT___)',
					'',
				].join('\n'),
			);
		});

		it('keeps the css-loader output of a development build', () => {
			expect(
				runLoader({ hot: false, mode: 'development', loader: 'css-loader' }),
			).toBe(
				[
					'CONTENT',
					'const { addTaggedAdditionalCSS } = require("@nativescript/core/ui/styling/style-scope");',
					'if (___CSS_LOADER_EXPORT___ && typeof ___CSS_LOADER_EXPORT___.forEach === "function") {',
					'\t___CSS_LOADER_EXPORT___.forEach(cssExport => {',
					'\t\tif (cssExport.length > 1 && cssExport[1]) {',
					'\t\t\t// applying the second item of the export as it contains the css contents',
					'\t\t\taddTaggedAdditionalCSS(cssExport[1], "/app/src/app.css");',
					'\t\t}',
					'\t});',
					'}',
					'',
				].join('\n'),
			);
		});

		it('keeps the css-loader output of a production build', () => {
			expect(
				runLoader({ hot: false, mode: 'production', loader: 'css-loader' }),
			).toBe(
				[
					'CONTENT',
					'const { addTaggedAdditionalCSS } = require("@nativescript/core/ui/styling/style-scope");',
					'if (___CSS_LOADER_EXPORT___ && typeof ___CSS_LOADER_EXPORT___.forEach === "function") {',
					'\t___CSS_LOADER_EXPORT___.forEach(cssExport => {',
					'\t\tif (cssExport.length > 1 && cssExport[1]) {',
					'\t\t\t// applying the second item of the export as it contains the css contents',
					'\t\t\taddTaggedAdditionalCSS(cssExport[1]);',
					'\t\t}',
					'\t});',
					'}',
					'',
				].join('\n'),
			);
		});
	});

	describe('with HMR', () => {
		const applyHotCssCall = `require(${JSON.stringify(HMR_RUNTIME_PATH)}).applyHotCss(module, "/app/src/app.css", ___APPLY_CSS_LOADER_CSS___, require("@nativescript/core/ui/styling/style-scope"))`;

		it.each([
			['development', ', "/app/src/app.css"'],
			['production', ''],
		] as const)(
			'hands the css2json-loader css to the HMR runtime in a %s build',
			(mode, tagCode) => {
				expect(runLoader({ hot: true, mode, loader: 'css2json-loader' })).toBe(
					[
						'CONTENT',
						'const ___APPLY_CSS_LOADER_CSS___ = [];',
						'const addTaggedAdditionalCSS = (css) => ___APPLY_CSS_LOADER_CSS___.push(css);',
						`addTaggedAdditionalCSS(___CSS2JSON_LOADER_EXPORT___${tagCode})`,
						applyHotCssCall,
					].join('\n'),
				);
			},
		);

		it.each([
			['development', ', "/app/src/app.css"'],
			['production', ''],
		] as const)(
			'hands the css-loader css to the HMR runtime in a %s build',
			(mode, tagCode) => {
				expect(runLoader({ hot: true, mode, loader: 'css-loader' })).toBe(
					[
						'CONTENT',
						'const ___APPLY_CSS_LOADER_CSS___ = [];',
						'const addTaggedAdditionalCSS = (css) => ___APPLY_CSS_LOADER_CSS___.push(css);',
						'if (___CSS_LOADER_EXPORT___ && typeof ___CSS_LOADER_EXPORT___.forEach === "function") {',
						'\t___CSS_LOADER_EXPORT___.forEach(cssExport => {',
						'\t\tif (cssExport.length > 1 && cssExport[1]) {',
						'\t\t\t// applying the second item of the export as it contains the css contents',
						`\t\t\taddTaggedAdditionalCSS(cssExport[1]${tagCode});`,
						'\t\t}',
						'\t});',
						'}',
						applyHotCssCall,
					].join('\n'),
				);
			},
		);

		it('registers each stylesheet under its tag and accepts its updates', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.a {}'));
			app.execute(
				'b.css',
				cssLoaderModule('/app/src/b.css', ['.b1 {}', '.b2 {}']),
			);

			expect(app.styleScope.sheets).toEqual([
				{ tag: '/app/src/app.css', css: '.a {}' },
				{ tag: '/app/src/b.css', css: '.b1 {}' },
				{ tag: '/app/src/b.css', css: '.b2 {}' },
			]);
			expect(app.hotObjects.get('app.css').accept).toHaveBeenCalled();
			expect(app.hotObjects.get('b.css').accept).toHaveBeenCalled();
		});

		it('keeps component styles after app.css when app.css is hot-replaced', () => {
			const app = createApp();
			app.execute(
				'app.css',
				css2jsonModule('/app/src/app.css', '.label { color: red; }'),
			);
			app.execute(
				'a.css',
				css2jsonModule('/app/src/a.css', '.label { color: orange; }'),
			);
			app.execute(
				'b.css',
				cssLoaderModule('/app/src/b.css', ['.b1 {}', '.b2 {}']),
			);

			app.update({
				'app.css': css2jsonModule(
					'/app/src/app.css',
					'.label { color: blue; }',
				),
			});

			expect(app.styleScope.sheets).toEqual([
				{ tag: '/app/src/app.css', css: '.label { color: blue; }' },
				{ tag: '/app/src/a.css', css: '.label { color: orange; }' },
				{ tag: '/app/src/b.css', css: '.b1 {}' },
				{ tag: '/app/src/b.css', css: '.b2 {}' },
			]);
		});

		it('keeps a hot-replaced component stylesheet at its position', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('a.css', css2jsonModule('/app/src/a.css', '.a {}'));
			app.execute('b.css', cssLoaderModule('/app/src/b.css', ['.b {}']));
			app.execute('c.css', css2jsonModule('/app/src/c.css', '.c {}'));
			app.styleScope.removeTaggedAdditionalCSS.mockClear();

			app.update({ 'b.css': cssLoaderModule('/app/src/b.css', ['.b2 {}']) });

			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app {}',
				'.a {}',
				'.b2 {}',
				'.c {}',
			]);
			expect(
				app.styleScope.removeTaggedAdditionalCSS.mock.calls.map(([tag]) => tag),
			).toEqual(['/app/src/b.css', '/app/src/b.css', '/app/src/c.css']);
		});

		it('keeps every style block of a component that shares one tag', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('c.vue?0', css2jsonModule('/app/src/c.vue', '.c0 {}'));
			app.execute('c.vue?1', css2jsonModule('/app/src/c.vue', '.c1 {}'));
			app.execute('d.css', css2jsonModule('/app/src/d.css', '.d {}'));

			app.update({ 'c.vue?0': css2jsonModule('/app/src/c.vue', '.c0-new {}') });

			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app {}',
				'.c0-new {}',
				'.c1 {}',
				'.d {}',
			]);

			app.update({ 'app.css': css2jsonModule('/app/src/app.css', '.app2 {}') });

			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app2 {}',
				'.c0-new {}',
				'.c1 {}',
				'.d {}',
			]);
		});

		it('places a new style block of a known tag at the position of its tag', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('c.vue?0', css2jsonModule('/app/src/c.vue', '.c0 {}'));
			app.execute('d.css', css2jsonModule('/app/src/d.css', '.d {}'));

			app.update({ 'c.vue?1': css2jsonModule('/app/src/c.vue', '.c1 {}') });

			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app {}',
				'.c0 {}',
				'.c1 {}',
				'.d {}',
			]);
		});

		it('keeps a style block at the position of its tag when its module id changes', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('c.vue?0', css2jsonModule('/app/src/c.vue', '.c0 {}'));
			app.execute('d.css', css2jsonModule('/app/src/d.css', '.d {}'));

			app.update({
				'c.vue?0': null,
				'c.vue?0&scoped': css2jsonModule('/app/src/c.vue', '.c0 {}'),
			});

			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app {}',
				'.c0 {}',
				'.d {}',
			]);
		});

		it('does not register unchanged css twice when a module runs again without a dispose', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('a.css', css2jsonModule('/app/src/a.css', '.a {}'));
			app.styleScope.addTaggedAdditionalCSS.mockClear();

			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));

			expect(app.styleScope.addTaggedAdditionalCSS).not.toHaveBeenCalled();
			expect(app.styleScope.removeTaggedAdditionalCSS).not.toHaveBeenCalled();
			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app {}',
				'.a {}',
			]);
		});

		it('does not resurrect a stylesheet whose module was disposed and not executed again', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('a.css', css2jsonModule('/app/src/a.css', '.a {}'));
			app.execute('b.css', css2jsonModule('/app/src/b.css', '.b {}'));

			app.update({ 'a.css': null });
			app.update({ 'app.css': css2jsonModule('/app/src/app.css', '.app2 {}') });

			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app2 {}',
				'.b {}',
			]);
		});

		it('only appends a disposed stylesheet that runs again outside a hot update', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('a.css', css2jsonModule('/app/src/a.css', '.a {}'));
			app.execute('b.css', css2jsonModule('/app/src/b.css', '.b {}'));
			app.update({ 'a.css': null });
			app.styleScope.removeTaggedAdditionalCSS.mockClear();

			app.execute('a.css', css2jsonModule('/app/src/a.css', '.a {}'));

			expect(app.styleScope.removeTaggedAdditionalCSS).not.toHaveBeenCalled();
			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app {}',
				'.b {}',
				'.a {}',
			]);
		});

		it('re-adds a disposed stylesheet at its position when a hot update executes it again', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('a.css', css2jsonModule('/app/src/a.css', '.a {}'));
			app.execute('b.css', css2jsonModule('/app/src/b.css', '.b {}'));
			app.update({ 'a.css': null });

			app.update({ 'a.css': css2jsonModule('/app/src/a.css', '.a {}') });

			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app {}',
				'.a {}',
				'.b {}',
			]);
		});

		it('passes the tag in a production build with HMR', () => {
			const app = createApp();
			app.execute(
				'app.css',
				css2jsonModule('/app/src/app.css', '.app {}', 'production'),
			);
			app.execute(
				'a.css',
				css2jsonModule('/app/src/a.css', '.a {}', 'production'),
			);

			app.update({
				'app.css': css2jsonModule('/app/src/app.css', '.app2 {}', 'production'),
			});

			expect(app.styleScope.sheets).toEqual([
				{ tag: '/app/src/app.css', css: '.app2 {}' },
				{ tag: '/app/src/a.css', css: '.a {}' },
			]);
		});

		it('does not throw when re-registering a stylesheet fails', () => {
			const app = createApp();
			app.execute('app.css', css2jsonModule('/app/src/app.css', '.app {}'));
			app.execute('a.css', css2jsonModule('/app/src/a.css', '.a {}'));
			app.execute('b.css', css2jsonModule('/app/src/b.css', '.b {}'));
			app.styleScope.addTaggedAdditionalCSS.mockImplementation((css, tag) => {
				if (tag === '/app/src/a.css') {
					throw new Error(`cannot add ${tag}`);
				}
				app.styleScope.sheets.push({ tag, css });
				return true;
			});

			expect(() =>
				app.update({
					'app.css': css2jsonModule('/app/src/app.css', '.app2 {}'),
				}),
			).not.toThrow();
			expect(app.styleScope.sheets.map((sheet) => sheet.css)).toEqual([
				'.app2 {}',
				'.b {}',
			]);
		});

		it('does not throw when removing a disposed stylesheet fails', () => {
			const app = createApp();
			app.execute('a.css', css2jsonModule('/app/src/a.css', '.a {}'));
			app.styleScope.removeTaggedAdditionalCSS.mockImplementation(() => {
				throw new Error('cannot remove');
			});

			expect(() => app.update({ 'a.css': null })).not.toThrow();
		});
	});
});
