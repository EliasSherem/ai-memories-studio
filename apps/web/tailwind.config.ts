import type { Config } from 'tailwindcss';
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { ink: '#263532', paper: '#f8f7f3', clay: '#a94e35' },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'], display: ['Georgia', 'serif'] },
    },
  },
  plugins: [],
} satisfies Config;
