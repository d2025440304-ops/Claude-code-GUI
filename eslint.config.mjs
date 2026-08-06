// ESLint flat config — TypeScript + React Hooks（经典规则）+ Prettier 兼容
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['dist', 'dist-electron', 'node_modules', 'vite.config.ts', 'vitest.config.ts', 'postcss.config.js', 'tailwind.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // 只启用经典两条 hooks 规则；v7 新增的 refs/set-state-in-effect/immutability
      // 等规则对存量代码过于激进（大量既有模式会被误报），暂不启用
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // agent 事件字段访问允许 any（SDK 事件形状过杂，属合理权衡），保持可见但不阻塞
      '@typescript-eslint/no-explicit-any': 'warn',
      // 死代码零容忍（CI 以 error 卡关）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 存量代码有大量"有意留空"的 catch（注释说明），允许空 catch
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ANSI 转义序列解析（\x1b 等）是合法用途
      'no-control-regex': 'off',
      // better-sqlite3 是 CJS 包，require 风格导入是必要的互操作
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
)
