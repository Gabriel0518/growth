// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // 只 lint 新单体仓库；旧栈不纳入。
    // 注意：flat config 的 ignores 相对本文件所在目录解析，'dashboard/**' 只匹配根级
    // dashboard/，不会匹配 archive/dashboard/（这点与 .prettierignore 的 gitignore
    // 语义不同——后者不带前导斜杠时任意层级都匹配）。旧栈已整体移进 archive/，故必须
    // 显式忽略 archive/**，否则 3000+ 条存量报错会把 pnpm lint 彻底淹掉。
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/node_modules/**',
      'archive/**',
      'scripts/**',
      // docs/ 是文档与原型参考代码（如 login-poc-reference/*.mjs），非项目源码，
      // 不纳入 lint（否则参考代码的 import/order、no-undef 等会污染 pnpm lint）。
      'docs/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  unicorn.configs['flat/recommended'],
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      'import/order': [
        'error',
        {
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-cycle': 'error',
      // noPropertyAccessFromIndexSignature 强制对 process.env / Record 索引签名用括号访问，
      // 与 dot-notation 规则冲突；放行索引签名的括号访问，其余仍要求点号。
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // 允许下划线前缀标记「有意未使用」的参数/变量/catch 绑定，与 tsconfig 的
      // noUnusedParameters 对下划线的豁免对齐。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // 单体仓库内部包命名带作用域，允许简短 kebab 文件名。
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off',
    },
  },
  {
    // 根级 JS 配置文件不属于任何 tsconfig，关闭类型感知规则避免误报。
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
  // ═══════════════════════════════════════════════════════════════
  // apps/web/ 目录的特殊规则
  // ═══════════════════════════════════════════════════════════════
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: {
      // AGENTS.md 明确：apps/web/ 内跨文件 import 不能带 .js 后缀。
      // Next.js webpack 按字面文件名查找，import './foo.js' 会找 foo.js
      // 文件而非 foo.ts 源文件 → 生产构建 Module not found。
      // 已踩坑 3 次：sync.js / token-service.js 等，别再犯了。
      //
      // packages/ 下相反——tsc --module NodeNext 要求带 .js ，所以这条规则不适用。
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./**/*.js', '../**/*.js', './*.js', '../*.js'],
              message:
                'apps/web/ 内跨文件 import 不要带 .js/.cjs 后缀。' +
                'Next.js webpack 按字面文件名查找，找不到 .ts 源文件。' +
                '去掉后缀即可（如 import { x } from "./sync"）。' +
                '详见 AGENTS.md § Lint 与格式化。',
            },
          ],
        },
      ],
    },
  },
);
