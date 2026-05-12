/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Manga B&W comic color palette
        claude: {
          // Light mode colors
          bg: '#F5F5F5',               // Off-white page background
          surface: '#FFFFFF',          // White cards/panels
          surfaceHover: '#EBEBEB',     // Light grey hover
          surfaceMuted: '#E5E5E5',     // Muted areas
          surfaceInset: '#E0E0E0',     // Inset areas
          border: '#E0E0E0',           // Subtle grey border
          borderLight: '#EBEBEB',      // Very subtle dividers
          text: '#0A0A0A',             // Black ink text
          textSecondary: '#555555',    // Grey halftone text
          // Dark mode colors
          darkBg: '#0A0A0A',           // Black page background
          darkSurface: '#1A1A1A',      // Dark grey panels
          darkSurfaceHover: '#2A2A2A', // Dark hover
          darkSurfaceMuted: '#151515', // Subtle dark area
          darkSurfaceInset: '#0D0D0D', // Dark inset areas
          darkBorder: '#2A2A2A',       // Subtle dark grey border
          darkBorderLight: '#1A1A1A',  // Very subtle dark dividers
          darkText: '#FFFFFF',         // White ink text
          darkTextSecondary: '#999999', // Light grey halftone
          // Accent (manga red)
          accent: '#FF3333',           // Comic red primary
          accentHover: '#CC0000',      // Deep red hover
          accentLight: '#FF6666',      // Light red for badges
          accentMuted: 'rgba(255,51,51,0.12)', // Very faint red background
        },
        primary: {
          DEFAULT: '#FF3333',
          dark: '#CC0000'
        },
        secondary: {
          DEFAULT: '#555555',
          dark: '#333333'
        }
      },
      boxShadow: {
        subtle: '0 1px 2px rgba(0,0,0,0.05)',
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        elevated: '0 4px 12px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.04)',
        modal: '0 8px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)',
        popover: '0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.05)',
        'glow-accent': '0 0 20px rgba(255,51,51,0.20)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-down': {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-up': 'fade-in-up 0.25s ease-out',
        'fade-in-down': 'fade-in-down 0.2s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        shimmer: 'shimmer 1.5s infinite',
      },
      borderRadius: {
        none: '0px',
        sm: '2px',
        DEFAULT: '4px',
        md: '4px',
        lg: '8px',
        xl: '8px',
        '2xl': '8px',
        '3xl': '8px',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      typography: {
        DEFAULT: {
          css: {
            color: '#0A0A0A',
            a: {
              color: '#FF3333',
              '&:hover': {
                color: '#CC0000',
              },
            },
            code: {
              color: '#0A0A0A',
              backgroundColor: 'rgba(26, 26, 26, 0.08)',
              padding: '0.2em 0.4em',
              fontWeight: '400',
            },
            'code::before': {
              content: '""',
            },
            'code::after': {
              content: '""',
            },
            pre: {
              backgroundColor: '#EBEBEB',
              color: '#0A0A0A',
              padding: '1em',
              overflowX: 'auto',
            },
            blockquote: {
              borderLeftColor: '#FF3333',
              color: '#555555',
            },
            h1: {
              color: '#0A0A0A',
            },
            h2: {
              color: '#0A0A0A',
            },
            h3: {
              color: '#0A0A0A',
            },
            h4: {
              color: '#0A0A0A',
            },
            strong: {
              color: '#0A0A0A',
            },
          },
        },
        dark: {
          css: {
            color: '#FFFFFF',
            a: {
              color: '#FF6666',
              '&:hover': {
                color: '#FF9999',
              },
            },
            code: {
              color: '#FFFFFF',
              backgroundColor: 'rgba(255, 255, 255, 0.08)',
              padding: '0.2em 0.4em',
              fontWeight: '400',
            },
            pre: {
              backgroundColor: '#1A1A1A',
              color: '#FFFFFF',
              padding: '1em',
              overflowX: 'auto',
            },
            blockquote: {
              borderLeftColor: '#FF3333',
              color: '#999999',
            },
            h1: {
              color: '#FFFFFF',
            },
            h2: {
              color: '#FFFFFF',
            },
            h3: {
              color: '#FFFFFF',
            },
            h4: {
              color: '#FFFFFF',
            },
            strong: {
              color: '#FFFFFF',
            },
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
