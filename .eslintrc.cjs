{
  "env": {
    "browser": true,
    "es2021": true,
    "node": true
  },
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended"
  ],
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "ecmaFeatures": {
      "jsx": true
    },
    "sourceType": "module"
  },
  "plugins": [
    "@typescript-eslint",
    "react"
  ],
  "rules": {
    "no-console": "warn",
    "no-unused-vars": "warn",
    "react/jsx-uses-vars": "error",
    "react/jsx-no-duplicate-props": "error",
    "react-hooks/exhaustive-deps": "warn"
  }
}