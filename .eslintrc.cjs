module.exports = {
  parser: "@typescript-eslint/parser",
  extends: ["plugin:@typescript-eslint/recommended", "prettier"],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-console": "error",
  },
  overrides: [
    {
      files: ["src/index.ts"],
      rules: {
        "no-console": "off",
      },
    },
  ],
};
