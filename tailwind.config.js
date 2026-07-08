/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'bg-base': 'var(--bg-base)',
        'bg-surface': 'var(--bg-surface)',
        'bg-surface-2': 'var(--bg-surface-2)',
        'bg-surface-3': 'var(--bg-surface-3)',
        'fg-primary': 'var(--fg-primary)',
        'fg-secondary': 'var(--fg-secondary)',
        'fg-tertiary': 'var(--fg-tertiary)',
        'border-default': 'var(--border-default)',
        'border-subtle': 'var(--border-subtle)',
        'accent-primary': 'var(--accent-primary)',
        'accent-bright': 'var(--accent-bright)',
        'accent-subtle': 'var(--accent-subtle)',
        'success': 'var(--success)',
        'warn': 'var(--warn)',
        'danger': 'var(--danger)',
      },
    },
  },
  plugins: [],
}
