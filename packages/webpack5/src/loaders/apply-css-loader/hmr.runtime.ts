interface StyleScope {
	addTaggedAdditionalCSS(cssText: unknown, tag: string): boolean;
	removeTaggedAdditionalCSS(tag: string): boolean;
}

// Per tag in first-registration order: each module's css, null once disposed.
type TagOrder = Map<string, Map<string | number, unknown[] | null>>;

const TAG_ORDER_KEY = '__NS_WEBPACK_CSS_TAG_ORDER__';

function getTagOrder(): TagOrder {
	const scope = globalThis as any;
	if (!scope[TAG_ORDER_KEY]) {
		scope[TAG_ORDER_KEY] = new Map();
	}
	return scope[TAG_ORDER_KEY];
}

function sameCss(previous: unknown[], css: unknown[]): boolean {
	return (
		previous.length === css.length &&
		previous.every(
			(cssText, index) =>
				cssText === css[index] ||
				JSON.stringify(cssText) === JSON.stringify(css[index]),
		)
	);
}

// Core appends a re-added tag last, so re-add every tag after it.
function reapplyFrom(
	order: TagOrder,
	tag: string,
	styleScope: StyleScope,
): void {
	let reached = false;
	for (const [otherTag, sheets] of order) {
		reached = reached || otherTag === tag;
		if (!reached) {
			continue;
		}
		try {
			styleScope.removeTaggedAdditionalCSS(otherTag);
			for (const css of sheets.values()) {
				for (const cssText of css || []) {
					styleScope.addTaggedAdditionalCSS(cssText, otherTag);
				}
			}
		} catch (e) {}
	}
}

/**
 * Applies the css of a stylesheet module in an HMR build, keeping its place in the
 * cascade when the module is hot-replaced.
 * @param module The webpack module of the stylesheet.
 * @param tag The tag the css is registered under.
 * @param css The css values of the module, as passed to addTaggedAdditionalCSS.
 * @param styleScope The `@nativescript/core/ui/styling/style-scope` module.
 */
export function applyHotCss(
	module: any,
	tag: string,
	css: unknown[],
	styleScope: StyleScope,
): void {
	const order = getTagOrder();
	const known = order.has(tag);
	if (!known) {
		order.set(tag, new Map());
	}
	const sheets = order.get(tag);
	const previous = sheets.get(module.id);
	const hot = module.hot;

	// Guards a module executed twice without a dispose in between.
	if (!previous || !sameCss(previous, css)) {
		// Outside hot updates, core could scope re-added tags to a loading page.
		if (known && hot?.status?.() === 'apply') {
			sheets.set(module.id, css);
			reapplyFrom(order, tag, styleScope);
		} else {
			css.forEach((cssText) => styleScope.addTaggedAdditionalCSS(cssText, tag));
			sheets.set(module.id, css);
		}
	}

	if (hot) {
		hot.accept();
		hot.dispose(() => {
			sheets.set(module.id, null);
			try {
				styleScope.removeTaggedAdditionalCSS(tag);
			} catch (e) {}
		});
	}
}
