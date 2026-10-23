import { create as createResolver } from 'enhanced-resolve';
import fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dedent } from 'ts-dedent';
import css2jsonLoader, {
	joinEscapedSelectorCommas,
} from '../../src/loaders/css2json-loader';

// the query vue-loader 17 emits for the second block, a <style module>
const moduleQuery = '?vue&type=style&index=1&id=592e7a1a&module=true&lang=css';

interface LoaderOutput {
	code: string;
	async: boolean;
	exports: any;
	ast: any;
}

interface RunOptions {
	hot?: boolean;
	loader?: typeof css2jsonLoader;
	resourcePath?: string;
	alias?: Record<string, string>;
	addDependency?: (file: string) => void;
}

// evaluates the generated module; `ast` is the stylesheet apply-css-loader registers
function evaluate(code: string, hot?: unknown) {
	const module = { exports: {} as any, hot };
	const body = code.replace(/^export default /m, 'module.exports.default = ');
	const ast = new Function(
		'module',
		'require',
		`${body}\nreturn ___CSS2JSON_LOADER_EXPORT___;`,
	)(module, () => ({}));
	return { exports: module.exports, ast };
}

function run(
	css: string,
	resourceQuery = '',
	options: RunOptions = {},
): Promise<LoaderOutput> {
	const {
		hot = false,
		loader = css2jsonLoader,
		resourcePath = '/app/components/Probe.vue',
		alias = {},
		addDependency = () => {},
	} = options;
	// stands in for webpack's resolver, with the app's `~` alias
	const resolver = createResolver({ alias, preferRelative: true });
	const resolveRequest = (context: string, request: string) =>
		new Promise((resolve, reject) => {
			resolver(context, request, (error, result) =>
				error ? reject(error) : resolve(result),
			);
		});

	return new Promise((resolve, reject) => {
		let async = false;
		const callback = (error: unknown, code: string) => {
			if (error) {
				reject(error);
				return;
			}
			resolve({ code, async, ...evaluate(code) });
		};
		loader.call(
			{
				getOptions: () => ({}),
				getResolve: () => resolveRequest,
				addDependency,
				fs,
				resourcePath,
				resourceQuery,
				hot,
				async: () => {
					async = true;
					return callback;
				},
				callback,
			},
			css,
			null,
		);
	});
}

async function runModule(css: string, resourceQuery = moduleQuery) {
	const output = await run(css, resourceQuery);
	return { ...output, classes: output.exports };
}

function runHot(code: string, data: unknown) {
	const hot = { data, invalidate: jest.fn(), dispose: jest.fn() };
	evaluate(code, hot);
	return hot;
}

describe('css2json-loader', () => {
	it('keeps an escaped comma inside a class name', async () => {
		const { ast } = await run(
			'.grid-cols-\\[repeat\\(auto-fill\\,minmax\\(260\\,1fr\\)\\)\\] { grid-template-columns: repeat(auto-fill,minmax(260,1fr)); }',
		);
		expect(ast.stylesheet.rules[0].selectors).toEqual([
			'.grid-cols-\\[repeat\\(auto-fill\\,minmax\\(260\\,1fr\\)\\)\\]',
		]);
	});

	it('still splits a real selector list, including in at-rules', async () => {
		const { ast } = await run(
			'.a\\,b, .c { color: red; } @media (min-width: 1px) { .x-\\[a\\,b\\], .y { color: red; } }',
		);
		expect(ast.stylesheet.rules[0].selectors).toEqual(['.a\\,b', '.c']);
		expect(ast.stylesheet.rules[1].rules[0].selectors).toEqual([
			'.x-\\[a\\,b\\]',
			'.y',
		]);
	});

	it('does not join after an escaped backslash', () => {
		expect(joinEscapedSelectorCommas(['.a\\\\', '.b'])).toEqual([
			'.a\\\\',
			'.b',
		]);
	});

	describe('non-module requests', () => {
		const css = '@import url("./partial.css");\n.probe { color: red; }';
		const expected = dedent`
			/* CSS2JSON */
			require("./partial.css")
			const ___CSS2JSON_LOADER_EXPORT___ = {"type":"stylesheet","stylesheet":{"rules":[{"type":"rule","selectors":[".probe"],"declarations":[{"type":"declaration","property":"color","value":"red"}]}],"parsingErrors":[]}}
			export default ___CSS2JSON_LOADER_EXPORT___
		`;

		it.each([
			['a plain stylesheet', ''],
			['a vue style block', '?vue&type=style&index=0&id=592e7a1a&lang=css'],
			[
				'a scoped vue style block',
				'?vue&type=style&index=0&id=592e7a1a&scoped=true&lang=css',
			],
			[
				'module=false',
				'?vue&type=style&index=0&id=592e7a1a&module=false&lang=css',
			],
		])('keep the synchronous output for %s', async (_name, resourceQuery) => {
			const output = await run(css, resourceQuery, { hot: true });
			expect(output.async).toBe(false);
			expect(output.code).toBe(expected);
			expect(output.exports.default).toBe(output.ast);
		});
	});

	describe('CSS modules requests', () => {
		it('export the class map as module.exports and scope the selectors', async () => {
			const { classes, ast, async } = await runModule(
				'.probe-mod { color: #654321; }\n@media (min-width: 1px) { .inside { color: green; } }',
			);
			expect(async).toBe(true);
			expect(Object.keys(classes)).toEqual(['probe-mod', 'inside']);
			expect(classes['probe-mod']).toMatch(/^_probe-mod_[0-9a-z]+_1$/);
			expect(ast.stylesheet.rules[0].selectors).toEqual([
				`.${classes['probe-mod']}`,
			]);
			expect(ast.stylesheet.rules[1].rules[0].selectors).toEqual([
				`.${classes.inside}`,
			]);
		});

		it('export only the class map, as CommonJS for vue-loader 15', async () => {
			const { classes, code } = await runModule(
				'.probe-mod { color: #654321; }\n.default { color: red; }\n.locals { color: blue; }',
			);
			// vue-loader 15 requires an `export *` proxy of this module
			expect(code).not.toMatch(/^\s*(import|export)\b/m);
			expect(Object.keys(classes)).toEqual(['probe-mod', 'default', 'locals']);
			expect(classes.default).toMatch(/^_default_[0-9a-z]+_2$/);
			expect(classes.locals).toMatch(/^_locals_[0-9a-z]+_3$/);
		});

		it('generate the same class names on every build', async () => {
			const css = '.probe-mod { color: #654321; }';
			const { classes } = await runModule(css);
			expect(classes['probe-mod']).toMatch(/^_probe-mod_[0-9a-z]+_1$/);
			expect((await runModule(css)).classes).toEqual(classes);
		});

		it('scope keyframes and the animations that use them', async () => {
			const { classes, ast } = await runModule(
				'@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }\n.anim { animation: pulse 1s; }',
			);
			expect(ast.stylesheet.rules[0].name).toBe(classes.pulse);
			expect(ast.stylesheet.rules[1].declarations[0].value).toBe(
				`${classes.pulse} 1s`,
			);
		});

		it('leave :global() class names unscoped and out of the map', async () => {
			const { classes, ast } = await runModule(
				':global(.app-wide) .probe-mod { color: red; }\n:local(.local) { color: blue; }',
			);
			expect(Object.keys(classes)).toEqual(['probe-mod', 'local']);
			expect(ast.stylesheet.rules[0].selectors).toEqual([
				`.app-wide .${classes['probe-mod']}`,
			]);
			expect(ast.stylesheet.rules[1].selectors).toEqual([`.${classes.local}`]);
		});

		it('resolve composes within the same file', async () => {
			const { classes, ast } = await runModule(
				'.base { font-size: 12; }\n.derived { composes: base; color: blue; }',
			);
			const [derived, base] = classes.derived.split(' ');
			expect(base).toBe(classes.base);
			expect(ast.stylesheet.rules[1].selectors).toEqual([`.${derived}`]);
			expect(ast.stylesheet.rules[1].declarations).toEqual([
				{ type: 'declaration', property: 'color', value: 'blue' },
			]);
		});

		it('support named modules', async () => {
			const { classes, ast } = await runModule(
				'.probe-mod { color: #654321; }',
				'?vue&type=style&index=1&id=592e7a1a&module=classes&lang=css',
			);
			expect(ast.stylesheet.rules[0].selectors).toEqual([
				`.${classes['probe-mod']}`,
			]);
		});

		it('support compiled lang="scss" blocks', async () => {
			const { compileString } = jest.requireActual('sass');
			const { css } = compileString(
				'$teal: #008080;\n.wrap { .inner { color: $teal; } }',
			);
			const { classes, ast } = await runModule(
				css,
				'?vue&type=style&index=1&id=592e7a1a&module=true&lang=scss',
			);
			expect(ast.stylesheet.rules[0].selectors).toEqual([
				`.${classes.wrap} .${classes.inner}`,
			]);
		});

		it('keep requiring @import rules that were not inlined', async () => {
			const { code, classes, ast } = await runModule(
				'@import url("./partial.css");\n.probe-mod { color: #654321; }',
			);
			expect(code).toContain('\nrequire("./partial.css")\n');
			expect(ast.stylesheet.rules).toHaveLength(1);
			expect(ast.stylesheet.rules[0].selectors).toEqual([
				`.${classes['probe-mod']}`,
			]);
		});

		it('fail on a CSS syntax error', async () => {
			await expect(
				run('.probe-mod { color: red;', moduleQuery),
			).rejects.toThrow('Unclosed block');
		});

		it('invalidate on hot update only when the class map changes', async () => {
			const first = await run('.probe-mod { color: red; }', moduleQuery, {
				hot: true,
			});
			const second = await run('.probe-mod { color: blue; }', moduleQuery, {
				hot: true,
			});
			const cold = await run('.probe-mod { color: red; }', moduleQuery);
			expect(first.exports).not.toEqual(second.exports);
			expect(cold.code).not.toContain('module.hot');

			const initial = runHot(first.code, undefined);
			expect(initial.invalidate).not.toHaveBeenCalled();
			const data: Record<string, unknown> = {};
			initial.dispose.mock.calls[0][0](data);

			expect(runHot(first.code, data).invalidate).not.toHaveBeenCalled();
			expect(runHot(second.code, data).invalidate).toHaveBeenCalledTimes(1);
		});

		it('load @vue/compiler-sfc only for CSS modules requests', async () => {
			const factory = jest.fn(() => jest.requireActual('@vue/compiler-sfc'));
			jest.doMock('@vue/compiler-sfc', factory);
			try {
				let loader: typeof css2jsonLoader;
				jest.isolateModules(() => {
					loader = require('../../src/loaders/css2json-loader').default;
				});

				await run('.probe { color: red; }', '', { loader });
				expect(factory).not.toHaveBeenCalled();
				await run('.probe { color: red; }', moduleQuery, { loader });
				expect(factory).toHaveBeenCalledTimes(1);
			} finally {
				jest.dontMock('@vue/compiler-sfc');
			}
		});

		describe('composes from another file', () => {
			const root = fs.realpathSync(
				fs.mkdtempSync(join(tmpdir(), 'css2json-loader-')),
			);
			const app = join(root, 'app');
			const styles = join(app, 'styles');
			const resourcePath = join(app, 'components', 'Probe.vue');
			const files: Record<string, string> = {
				'shared.css':
					".shared { color: red; }\n.other { composes: deep from './deep.css'; }",
				'deep.css': '.deep { font-size: 10; }',
				'broken.css': '.broken { color: red;',
				'nested-error.css': '.nested { composes: missing; }',
				'cycle-a.css': ".a { composes: b from './cycle-b.css'; }",
				'cycle-b.css': ".b { composes: a from './cycle-a.css'; }",
				'with-import.css': "@import './deep.css';\n.imported { color: red; }",
				'theme.scss': '.themed { color: red; }',
			};

			beforeAll(() => {
				fs.mkdirSync(styles, { recursive: true });
				for (const [name, css] of Object.entries(files)) {
					fs.writeFileSync(join(styles, name), css);
				}
			});

			afterAll(() => {
				fs.rmSync(root, { recursive: true, force: true });
			});

			function runComposes(css: string) {
				const addDependency = jest.fn();
				const output = run(css, moduleQuery, {
					resourcePath,
					alias: { '~': app },
					addDependency,
				});
				return { output, addDependency };
			}

			it('include the composed rules and watch the composed files', async () => {
				const { output, addDependency } = runComposes(
					'.title { composes: shared from "../styles/shared.css"; color: blue; }',
				);
				const { exports: classes, ast } = await output;
				const [title, shared] = classes.title.split(' ');
				expect(shared).toMatch(/^_shared_[0-9a-z]+_1$/);
				expect(
					ast.stylesheet.rules.map((rule: any) => rule.selectors[0]),
				).toEqual([
					expect.stringMatching(/^\._deep_/),
					`.${shared}`,
					expect.stringMatching(/^\._other_/),
					`.${title}`,
				]);
				expect(addDependency.mock.calls).toEqual([
					[join(styles, 'shared.css')],
					[join(styles, 'deep.css')],
				]);
			});

			it("resolve with webpack's resolver and include a file once", async () => {
				const { output } = runComposes(
					'.a { composes: shared from "~/styles/shared.css"; }\n.b { composes: other from "../styles/shared.css"; }',
				);
				const { exports: classes, ast } = await output;
				expect(classes.a.split(' ')[1]).toMatch(/^_shared_/);
				expect(classes.b.split(' ').slice(1)).toEqual([
					expect.stringMatching(/^_other_/),
					expect.stringMatching(/^_deep_/),
				]);
				expect(ast.stylesheet.rules).toHaveLength(5);
			});

			it.each([
				['a missing file', '../styles/shraed.css', "Can't resolve"],
				['a CSS syntax error', '../styles/broken.css', 'Unclosed block'],
				[
					'an error in the composed file',
					'../styles/nested-error.css',
					'referenced class name "missing" in composes not found',
				],
				[
					'circular composes',
					'../styles/cycle-a.css',
					`Circular composes: ${resourcePath} -> ${join(
						styles,
						'cycle-a.css',
					)} -> ${join(styles, 'cycle-b.css')} -> ${join(
						styles,
						'cycle-a.css',
					)}`,
				],
				[
					'a file that is not CSS',
					'../styles/theme.scss',
					'composes can only load .css files',
				],
				[
					'an @import in the composed file',
					'../styles/with-import.css',
					'@import is not supported in a file loaded by composes',
				],
			])('fail the module on %s', async (_name, file, message) => {
				const { output } = runComposes(
					`.title { composes: x from "${file}"; }`,
				);
				await expect(output).rejects.toThrow(message);
			});
		});
	});
});
