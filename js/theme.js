// Colour themes and fonts. Light is the default.

export const COLOR_KEYS = [
  ['bg', 'Background'], ['surface', 'Panels'], ['line', 'Grid lines'], ['text', 'Text'], ['muted', 'Muted text'],
  ['up', 'Bullish'], ['down', 'Bearish'], ['accent', 'Accent'], ['warn', 'Warning'],
];

export const PRESETS = {
  Light: { bg: '#ffffff', surface: '#f4f6f8', line: '#e3e7ec', text: '#0f172a', muted: '#64748b', up: '#057a55', down: '#d92d20', accent: '#1d4ed8', warn: '#b45309' },
  Terminal: { bg: '#000000', surface: '#0f0f0f', line: '#262626', text: '#ffb000', muted: '#a8792b', up: '#00d26a', down: '#ff4d4d', accent: '#4ea8ff', warn: '#ffb000' },
  Midnight: { bg: '#0b1220', surface: '#111a2e', line: '#1e293b', text: '#e2e8f0', muted: '#94a3b8', up: '#22c55e', down: '#f87171', accent: '#60a5fa', warn: '#fbbf24' },
  Paper: { bg: '#fbf8f1', surface: '#f3eee2', line: '#e4dccb', text: '#2b2620', muted: '#7a705f', up: '#2f7d32', down: '#b3261e', accent: '#8a4b0f', warn: '#9a6700' },
};

// Bloomberg's own terminal typeface is proprietary; IBM Plex Mono is an open (SIL OFL) font
// with a similar dense, technical look.
export const FONTS = {
  'IBM Plex Mono': "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
  'JetBrains Mono': "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
  'Roboto Mono': "'Roboto Mono', ui-monospace, Menlo, Consolas, monospace",
  'IBM Plex Sans': "'IBM Plex Sans', system-ui, sans-serif",
  System: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};

export function applyTheme(theme) {
  const root = document.documentElement;
  for (const [k] of COLOR_KEYS) root.style.setProperty(`--${k}`, theme.colors[k]);
  root.style.setProperty('--font', FONTS[theme.font] || FONTS['IBM Plex Mono']);
  root.style.colorScheme = luminance(theme.colors.bg) < 0.4 ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.colors.bg);
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
}
