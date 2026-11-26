import parser from "@typescript-eslint/parser"
import plugin from "@typescript-eslint/eslint-plugin"

export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "@typescript-eslint": plugin },
    rules: {
      ...plugin.configs.recommended.rules,
      "no-console": "error",
      // Generators without a yield are how Effect.fn bodies start out.
      "require-yield": "off",
    },
  },
  {
    // The library runs in a browser, a Worker and Node alike, and its edges
    // belong to the caller.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["node:*", "bun:*", "@effect/platform-*"] },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='Effect'][callee.property.name=/^run(Promise|Sync|Fork)/]",
          message: "No Effect.run* under src/: every edge is the caller's.",
        },
      ],
    },
  },
  {
    // The family boundary: core imports no chain SDK and no adapter.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "node:*",
            "bun:*",
            "@effect/platform-*",
            "viem",
            "viem/*",
            "@solana/*",
            "@mysten/*",
            "buffer",
            "../evm/*",
            "../solana/*",
            "../sui/*",
          ],
        },
      ],
    },
  },
  { files: ["scripts/**/*.ts"], rules: { "no-console": "off" } },
]
