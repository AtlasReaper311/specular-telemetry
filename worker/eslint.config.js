// Flat config, no plugin dependencies: the estate gate is "does the
// Worker parse and avoid the obvious footguns", not a style debate.
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Response: "readonly",
        Request: "readonly",
        URL: "readonly",
        fetch: "readonly",
        caches: "readonly",
        console: "readonly",
        AbortSignal: "readonly",
        crypto: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
    },
  },
];
