import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Flat config is order-dependent, so this must come AFTER the Next preset.
    // App Router has no pages/_document, which is what the rule checks for; the
    // font is preconnected and loaded in src/app/layout.tsx, the correct place.
    rules: { "@next/next/no-page-custom-font": "off" },
  },
  {
    ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", ".pgdata/**"],
  },
];

export default eslintConfig;
