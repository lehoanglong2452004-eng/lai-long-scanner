// User settings, kept in this browser only.
import { PRESETS } from './theme.js';

const KEY = 'lls.settings.v1';

export const DEFAULTS = {
  tf: 'H1',
  group: 'All',
  sort: 'default',
  useClosedBar: true,
  tdKey: '',
  tdRefreshMin: 15,
  sources: {},
  theme: { preset: 'Light', font: 'IBM Plex Mono', colors: { ...PRESETS.Light } },
};

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* private mode or blocked storage */ }
  return {
    ...DEFAULTS, ...saved,
    sources: { ...(saved.sources || {}) },
    theme: { ...DEFAULTS.theme, ...(saved.theme || {}), colors: { ...DEFAULTS.theme.colors, ...(saved.theme?.colors || {}) } },
  };
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
