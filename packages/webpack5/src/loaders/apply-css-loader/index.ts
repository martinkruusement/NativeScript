import { dedent } from 'ts-dedent';

const cssLoaderWarning = dedent`
	The apply-css-loader requires the file to be pre-processed by either css-loader or css2json-loader.
	Make sure the appropriate loader is applied before apply-css-loader.
`;

// Absolute, so every stylesheet resolves the same runtime module.
const hmrRuntimePath = JSON.stringify(require.resolve('./hmr.runtime'));

export default function loader(content, map) {
	const hasLoader = (loader: string) => {
		return this.loaders
			?.slice(this.loaderIndex)
			.some(({ path }) => path.includes(loader));
	};
	// add a tag to the applied css
	const tag = JSON.stringify(this.resourcePath);
	const tagCode =
		this.mode === 'development' ? `, ${JSON.stringify(this.resourcePath)}` : '';

	// In HMR builds the runtime applies the css, keeping the cascade order.
	const addCode = this.hot
		? dedent`
			const ___APPLY_CSS_LOADER_CSS___ = [];
			const addTaggedAdditionalCSS = (css) => ___APPLY_CSS_LOADER_CSS___.push(css);
		`
		: `const { addTaggedAdditionalCSS } = require("@nativescript/core/ui/styling/style-scope");`;

	const hmrCode = this.hot
		? dedent`
			require(${hmrRuntimePath}).applyHotCss(module, ${tag}, ___APPLY_CSS_LOADER_CSS___, require("@nativescript/core/ui/styling/style-scope"))
		`
		: ``;

	if (hasLoader('css2json-loader')) {
		content = dedent`
			${content}
			${addCode}
			addTaggedAdditionalCSS(___CSS2JSON_LOADER_EXPORT___${tagCode})
			${hmrCode}
		`;
	} else if (hasLoader('css-loader')) {
		content = dedent`
			${content}
			${addCode}
			if (___CSS_LOADER_EXPORT___ && typeof ___CSS_LOADER_EXPORT___.forEach === "function") {
				___CSS_LOADER_EXPORT___.forEach(cssExport => {
					if (cssExport.length > 1 && cssExport[1]) {
						// applying the second item of the export as it contains the css contents
						addTaggedAdditionalCSS(cssExport[1]${tagCode});
					}
				});
			}
			${hmrCode}
		`;
	} else {
		this.emitWarning(new Error(cssLoaderWarning));
	}

	this.callback(null, content, null);
}
