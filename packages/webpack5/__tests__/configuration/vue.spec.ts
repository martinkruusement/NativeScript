import Config from 'webpack-chain';
import fs from 'fs';

import vue from '../../src/configuration/vue';
import * as dependenciesHelpers from '../../src/helpers/dependencies';
import { init } from '../../src';

// the vue-loader @nativescript/webpack itself depends on
jest.mock('vue-loader/package.json', () => ({ version: '17.4.2' }));

const mockTemplateCompiler = { name: 'nativescript-vue-template-compiler' };
jest.mock('nativescript-vue-template-compiler', () => mockTemplateCompiler, {
	virtual: true,
});

describe('vue configuration', () => {
	const platforms = ['ios', 'android'];
	const originalGetDependencyVersion = dependenciesHelpers.getDependencyVersion;
	let getDependencyVersionSpy: jest.SpiedFunction<
		typeof dependenciesHelpers.getDependencyVersion
	>;
	let projectVueLoaderVersion: string | null;
	let projectNativeScriptVueVersion: string | null;

	beforeEach(() => {
		projectVueLoaderVersion = '17.4.2';
		projectNativeScriptVueVersion = '3.1.2';
		getDependencyVersionSpy = jest.spyOn(
			dependenciesHelpers,
			'getDependencyVersion',
		);
		getDependencyVersionSpy.mockImplementation((name) => {
			if (name === 'vue-loader') {
				return projectVueLoaderVersion;
			}

			if (name === 'nativescript-vue') {
				return projectNativeScriptVueVersion;
			}

			return originalGetDependencyVersion(name);
		});
	});

	afterEach(() => {
		getDependencyVersionSpy.mockRestore();
	});

	for (let platform of platforms) {
		it(`for ${platform}`, () => {
			init({
				[platform]: true,
			});
			expect(vue(new Config()).toString()).toMatchSnapshot();
		});
	}

	// looked up by name, the way nativescript-vue's webpack plugin does
	function getStylePostLoaders(config: Config) {
		return ['css', 'scss'].map((rule) =>
			config.module.rules.get(rule).uses.get('vue-css-loader').get('loader'),
		);
	}

	function getVueLoaderOptions(config: Config) {
		return config.module.rules.get('vue').uses.get('vue-loader').get('options');
	}

	function generateConfig() {
		init({
			ios: true,
		});

		return vue(new Config());
	}

	// console.warn stays spied by jest.mockWarn, so unexpected errors fail
	function getFilesPatchedForHMR() {
		const writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync');
		writeFileSyncSpy.mockImplementation(() => {});

		try {
			init({
				ios: true,
				hmr: true,
			});
			vue(new Config());

			return writeFileSyncSpy.mock.calls.map(([path]) => path);
		} finally {
			writeFileSyncSpy.mockRestore();
		}
	}

	describe('with vue-loader 15 in the project', () => {
		beforeEach(() => {
			projectVueLoaderVersion = '15.9.8';
			projectNativeScriptVueVersion = '2.9.3';
		});

		it('uses the vue-loader 15 stylePostLoader', () => {
			expect(getStylePostLoaders(generateConfig())).toEqual([
				'vue-loader/lib/loaders/stylePostLoader.js',
				'vue-loader/lib/loaders/stylePostLoader.js',
			]);
		});

		it('passes the Vue 2 template compiler to vue-loader', () => {
			expect(getVueLoaderOptions(generateConfig())).toStrictEqual({
				compiler: mockTemplateCompiler,
			});
		});

		it('patches vue-loader for HMR', () => {
			expect(getFilesPatchedForHMR()).toEqual([
				expect.stringMatching(/vue-loader[\\/]lib[\\/]index\.js$/),
			]);
		});
	});

	describe('with vue-loader 17 in the project', () => {
		it('uses the vue-loader 17 stylePostLoader', () => {
			expect(getStylePostLoaders(generateConfig())).toEqual([
				'vue-loader/dist/stylePostLoader.js',
				'vue-loader/dist/stylePostLoader.js',
			]);
		});

		it('disables the server build instead of passing the Vue 2 template compiler', () => {
			expect(getVueLoaderOptions(generateConfig())).toStrictEqual({
				isServerBuild: false,
			});
		});

		it('does not patch vue-loader for HMR', () => {
			expect(getFilesPatchedForHMR()).toEqual([]);
			expect('Failed to patch VueLoader').not.toHaveBeenWarned();
		});
	});

	describe('with nativescript-vue 2 and only vue-loader 17 in the project', () => {
		beforeEach(() => {
			projectNativeScriptVueVersion = '2.9.3';
		});

		it('keeps the vue-loader 15 configuration', () => {
			const config = generateConfig();

			expect(getStylePostLoaders(config)).toEqual([
				'vue-loader/lib/loaders/stylePostLoader.js',
				'vue-loader/lib/loaders/stylePostLoader.js',
			]);
			expect(getVueLoaderOptions(config)).toStrictEqual({
				compiler: mockTemplateCompiler,
			});
			expect(getFilesPatchedForHMR()).toEqual([
				expect.stringMatching(/vue-loader[\\/]lib[\\/]index\.js$/),
			]);
			expect('needs vue-loader 15').toHaveBeenWarned();
		});

		it('logs that it needs vue-loader 15 and links the Vue 2 setup', () => {
			generateConfig();

			expect(console.warn).toHaveBeenCalledTimes(1);
			expect(
				'nativescript-vue 2.9.3 needs vue-loader 15, but vue-loader 17.4.2 was found.',
			).toHaveBeenWarned();
			expect(
				'https://github.com/NativeScript/NativeScript/issues/11009',
			).toHaveBeenWarned();
		});
	});

	it.each([
		['2.9.3', '15.9.8'],
		['3.1.2', '17.4.2'],
	])(
		'logs no error for nativescript-vue %s with vue-loader %s',
		(nativescriptVueVersion, vueLoaderVersion) => {
			projectNativeScriptVueVersion = nativescriptVueVersion;
			projectVueLoaderVersion = vueLoaderVersion;
			generateConfig();

			expect(console.warn).not.toHaveBeenCalled();
		},
	);

	it('falls back to the vue-loader of @nativescript/webpack', () => {
		projectVueLoaderVersion = null;
		const config = generateConfig();

		expect(getStylePostLoaders(config)).toEqual([
			'vue-loader/dist/stylePostLoader.js',
			'vue-loader/dist/stylePostLoader.js',
		]);
		expect(getVueLoaderOptions(config)).toStrictEqual({
			isServerBuild: false,
		});
	});
});
