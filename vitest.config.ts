import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['apps/**/test/**/*.test.{ts,tsx}','apps/**/src/**/*.test.{ts,tsx}'],testTimeout:15000,restoreMocks:true},esbuild:{jsx:'automatic'}});
