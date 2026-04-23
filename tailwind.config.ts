import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx,mdx}',
    './src/shared/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
	extend: {
		colors: {
			border: 'hsl(var(--border))',
			input: 'hsl(var(--input))',
			ring: 'hsl(var(--ring))',
			background: 'hsl(var(--background))',
			foreground: 'hsl(var(--foreground))',
			primary: {
				DEFAULT: 'hsl(var(--primary))',
				foreground: 'hsl(var(--primary-foreground))'
			},
			secondary: {
				DEFAULT: 'hsl(var(--secondary))',
				foreground: 'hsl(var(--secondary-foreground))'
			},
			destructive: {
				DEFAULT: 'hsl(var(--destructive))',
				foreground: 'hsl(var(--destructive-foreground))'
			},
			muted: {
				DEFAULT: 'hsl(var(--muted))',
				foreground: 'hsl(var(--muted-foreground))'
			},
			accent: {
				DEFAULT: 'hsl(var(--accent))',
				foreground: 'hsl(var(--accent-foreground))'
			},
			popover: {
				DEFAULT: 'hsl(var(--popover))',
				foreground: 'hsl(var(--popover-foreground))'
			},
			card: {
				DEFAULT: 'hsl(var(--card))',
				foreground: 'hsl(var(--card-foreground))'
			},
			chart: {
				'1': 'hsl(var(--chart-1))',
				'2': 'hsl(var(--chart-2))',
				'3': 'hsl(var(--chart-3))',
				'4': 'hsl(var(--chart-4))',
				'5': 'hsl(var(--chart-5))'
			},
			sidebar: {
				DEFAULT: 'hsl(var(--sidebar-background) / <alpha-value>)',
				foreground: 'hsl(var(--sidebar-foreground) / <alpha-value>)',
				primary: 'hsl(var(--sidebar-primary) / <alpha-value>)',
				'primary-foreground': 'hsl(var(--sidebar-primary-foreground) / <alpha-value>)',
				accent: 'hsl(var(--sidebar-accent) / <alpha-value>)',
				'accent-foreground': 'hsl(var(--sidebar-accent-foreground) / <alpha-value>)',
				border: 'hsl(var(--sidebar-border) / <alpha-value>)',
				ring: 'hsl(var(--sidebar-ring) / <alpha-value>)'
			}
		},
		borderRadius: {
			lg: 'var(--radius)',
			md: 'calc(var(--radius) - 2px)',
			sm: 'calc(var(--radius) - 4px)'
		},
		fontSize: {
			// Proportional ~13/14 reduction applied to the default Tailwind scale.
			// `2xs` is a new micro-label size below Tailwind's defaults for badges/chips.
			'2xs': ['10px', { lineHeight: '0.875rem' }],
			xs: ['11px', { lineHeight: '1rem' }],
			sm: ['13px', { lineHeight: '1.25rem' }],
			base: ['15px', { lineHeight: '1.5rem' }],
			lg: ['17px', { lineHeight: '1.75rem' }],
			xl: ['20px', { lineHeight: '1.75rem' }],
			'2xl': ['22px', { lineHeight: '2rem' }],
			'3xl': ['28px', { lineHeight: '2.25rem' }],
			'4xl': ['34px', { lineHeight: '2.625rem' }],
			'5xl': ['42px', { lineHeight: '3rem' }],
			'6xl': ['56px', { lineHeight: '3.75rem' }],
			'7xl': ['68px', { lineHeight: '4.5rem' }],
			'8xl': ['88px', { lineHeight: '5.875rem' }],
			'9xl': ['120px', { lineHeight: '7.75rem' }],
		},
		keyframes: {
			'cobalt-glow': {
				'0%, 100%': {
					boxShadow: '0 0 8px 2px rgba(30, 64, 175, 0.3), 0 0 20px 4px rgba(37, 99, 235, 0.15), 0 0 40px 8px rgba(59, 130, 246, 0.08)',
				},
				'33%': {
					boxShadow: '0 0 12px 4px rgba(37, 99, 235, 0.4), 0 0 28px 8px rgba(59, 130, 246, 0.2), 0 0 50px 12px rgba(96, 165, 250, 0.1)',
				},
				'66%': {
					boxShadow: '0 0 6px 1px rgba(30, 64, 175, 0.25), 0 0 16px 3px rgba(37, 99, 235, 0.12), 0 0 32px 6px rgba(59, 130, 246, 0.06)',
				},
			},
			'dot-wave': {
				'0%, 40%, 100%': {
					opacity: '0.25',
				},
				'10%': {
					opacity: '1',
				},
			},
		},
		animation: {
			'cobalt-glow': 'cobalt-glow 4s ease-in-out infinite',
			'dot-wave': 'dot-wave 2s ease-in-out infinite',
		}
	}
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
}

export default config
