import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default defineConfig([
	{
		ignores: [
			"main.js",
			"node_modules/**",
			".git/**",
			".patina/**",
			".pi/**",
			"layer/**",
			"vitest.config.ts",
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts", "reference/**/*.ts", "tests/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.json",
			},
		},
		rules: {
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
	{
		files: ["*.mjs", "*.config.mjs", "version-bump.mjs"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
		},
	},
]);
