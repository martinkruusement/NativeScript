import { parse, Import, Stylesheet } from 'css';
import { urlToRequest } from 'loader-utils';
import { dirname } from 'path';
import type { Document, Root } from 'postcss';
import { dedent } from 'ts-dedent';

const betweenQuotesPattern = /('|")(.*?)\1/;
const unpackUrlPattern = /url\(([^\)]+)\)/;
const inlineLoader = '!css2json-loader?useForImports!';

export default function loader(content: string, map: any) {
	const options = this.getOptions() || {};
	const inline = !!options.useForImports;
	const requirePrefix = inline ? inlineLoader : '';
	const query = new URLSearchParams(this.resourceQuery || '');

	// vue-loader requests <style module> as module=true, named ones as module=<name>
	if (query.has('module') && query.get('module') !== 'false') {
		const callback = this.async();
		compileCssModule(this, content, query.get('id') || '', requirePrefix).then(
			(code) => callback(null, code, map),
			(error) => callback(error),
		);
		return;
	}

	this.callback(
		null,
		generateCode(
			content,
			requirePrefix,
			'export default ___CSS2JSON_LOADER_EXPORT___',
		),
		map,
	);
}

function generateCode(
	content: string,
	requirePrefix: string,
	exportCode: string,
): string {
	const ast = parse(content);
	repairSelectors(ast.stylesheet?.rules);

	// todo: revise if this is necessary
	// todo: perhaps use postCSS and just build imports into a single file?
	let dependencies = [];
	getAndRemoveImportRules(ast)
		.map(extractUrlFromRule)
		.map(createRequireUri)
		.forEach(({ uri, requireURI }) => {
			dependencies.push(`require("${requirePrefix}${requireURI}")`);
		});

	const str = JSON.stringify(ast, (k, v) => (k === 'position' ? undefined : v));

	return dedent`
	/* CSS2JSON */
	${dependencies.join('\n')}
	const ___CSS2JSON_LOADER_EXPORT___ = ${str}
	${exportCode}
	`;
}

interface CssModule {
	code: string;
	modules: Record<string, string>;
	root: Root | Document;
}

// the options css-loader resolves `composes: x from "file"` with
const composesResolveOptions = {
	dependencyType: 'icss',
	conditionNames: ['style'],
	extensions: ['...'],
	mainFields: ['css', 'style', 'main', '...'],
	mainFiles: ['index', '...'],
	preferRelative: true,
};

async function compileCssModule(
	loaderContext: any,
	content: string,
	id: string,
	requirePrefix: string,
): Promise<string> {
	const { resourcePath } = loaderContext;
	const { code, modules } = await compileModule(
		loaderContext,
		content,
		resourcePath,
		id,
		[resourcePath],
	);

	// CommonJS: vue-loader 15's proxy namespace then carries the class keys
	const moduleCode = generateCode(
		code,
		requirePrefix,
		dedent`
			const ___CSS2JSON_LOADER_LOCALS___ = ${JSON.stringify(modules)}
			module.exports = ___CSS2JSON_LOADER_LOCALS___
		`,
	);
	if (!loaderContext.hot) {
		return moduleCode;
	}

	// apply-css-loader self-accepts: renamed classes must reach the importing component
	return dedent`
		${moduleCode}
		if (module.hot) {
			const cssModules = JSON.stringify(___CSS2JSON_LOADER_LOCALS___);
			if (module.hot.data && module.hot.data.cssModules !== cssModules) {
				module.hot.invalidate();
			}
			module.hot.dispose((data) => {
				data.cssModules = cssModules;
			});
		}
	`;
}

// chain: the files whose composes led here, to report circular composes
async function compileModule(
	loaderContext: any,
	source: string,
	filename: string,
	id: string,
	chain: string[],
): Promise<CssModule> {
	// required lazily: only CSS modules requests need the SFC compiler
	const { compileStyleAsync } =
		require('@vue/compiler-sfc') as typeof import('@vue/compiler-sfc');
	const { code, modules, errors, rawResult } = await compileStyleAsync({
		source,
		filename,
		id,
		modules: true,
		modulesOptions: {
			Loader: createComposesLoader(loaderContext, id, chain),
		} as any,
	});
	if (errors.length) {
		throw errors[0];
	}
	return { code, modules, root: rawResult.root };
}

// postcss-modules' FileSystemLoader crashes the process on a missing composed file
function createComposesLoader(loaderContext: any, id: string, chain: string[]) {
	return class ComposesLoader {
		private files: string[] = [];
		private loaded = new Map<string, Promise<CssModule>>();
		private sources = new Map<string, string>();

		async fetch(request: string, importer: string) {
			// taken before any await: the composed CSS keeps the import order
			const index = this.files.push('') - 1;
			const resolve = loaderContext.getResolve(composesResolveOptions);
			const file: string = await resolve(dirname(importer), request);
			this.files[index] = file;
			if (!this.loaded.has(file)) {
				this.loaded.set(file, loadComposedFile(loaderContext, file, id, chain));
			}
			const { code, modules } = await this.loaded.get(file);
			this.sources.set(file, code);
			return modules;
		}

		// read by postcss-modules once every fetch has resolved
		get finalSource() {
			return [...new Set(this.files)]
				.map((file) => this.sources.get(file))
				.join('');
		}
	};
}

async function loadComposedFile(
	loaderContext: any,
	file: string,
	id: string,
	chain: string[],
): Promise<CssModule> {
	if (chain.includes(file)) {
		throw new Error(`Circular composes: ${[...chain, file].join(' -> ')}`);
	}
	// the file is read as is, without the loaders of its rule
	if (!/\.css$/i.test(file)) {
		throw new Error(`composes can only load .css files, not ${file}`);
	}
	loaderContext.addDependency(file);
	const source = await new Promise<string>((resolve, reject) => {
		loaderContext.fs.readFile(file, (error: Error, data: Buffer) => {
			if (error) {
				reject(error);
			} else {
				resolve(data.toString('utf-8'));
			}
		});
	});
	const result = await compileModule(loaderContext, source, file, id, [
		...chain,
		file,
	]);
	result.root.walkAtRules('import', (rule) => {
		// its url would be required relative to the wrong file
		throw rule.error('@import is not supported in a file loaded by composes');
	});
	return result;
}

function getImportRules(ast: Stylesheet): Import[] {
	if (!ast || (<any>ast).type !== 'stylesheet' || !ast.stylesheet) {
		return [];
	}
	return <Import[]>(
		ast.stylesheet.rules.filter(
			(rule) => rule.type === 'import' && (<any>rule).import,
		)
	);
}

function getAndRemoveImportRules(ast: Stylesheet): Import[] {
	const imports = getImportRules(ast);
	ast.stylesheet.rules = ast.stylesheet.rules.filter(
		(rule) => rule.type !== 'import',
	);

	return imports;
}

/**
 * Extracts the url from import rule (ex. `url("./platform.css")`)
 */
function extractUrlFromRule(importRule: Import): string {
	const urlValue = importRule.import;

	const unpackedUrlMatch = urlValue.match(unpackUrlPattern);
	const unpackedValue = unpackedUrlMatch ? unpackedUrlMatch[1] : urlValue;

	const quotesMatch = unpackedValue.match(betweenQuotesPattern);
	return quotesMatch ? quotesMatch[2] : unpackedValue;
}

function createRequireUri(uri): { uri: string; requireURI: string } {
	return {
		uri: uri,
		requireURI: urlToRequest(uri),
	};
}

/**
 * `css` splits a selector list on every comma outside parentheses and counts an escaped `\(` as a
 * parenthesis, so an escaped `\,` in a class name (Tailwind's `grid-cols-[repeat(auto-fill,...)]`)
 * splits the class in two and neither half matches. A piece ending in an odd number of
 * backslashes ended on an escaped comma: glue it back to the next one.
 */
export function joinEscapedSelectorCommas(selectors: string[]): string[] {
	const joined: string[] = [];
	for (const selector of selectors) {
		const previous = joined[joined.length - 1];
		if (previous !== undefined && /(?:^|[^\\])(?:\\\\)*\\$/.test(previous)) {
			joined[joined.length - 1] = `${previous},${selector}`;
		} else {
			joined.push(selector);
		}
	}
	return joined;
}

function repairSelectors(rules: any[] | undefined): void {
	if (!Array.isArray(rules)) return;
	for (const rule of rules) {
		if (Array.isArray(rule?.selectors)) {
			rule.selectors = joinEscapedSelectorCommas(rule.selectors);
		}
		// @media, @supports, ... nest their rules.
		repairSelectors(rule?.rules);
	}
}
