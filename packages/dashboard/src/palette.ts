// Mirror of the CSS design tokens in styles.css so SVG/canvas charts
// (which can't read CSS variables off arbitrary elements) share one source of truth.

export interface Palette {
  bg: string;
  panel: string;
  border: string;
  fg: string;
  fg2: string;
  fg3: string;
  accent: string;
  accent2: string;
  green: string;
  orange: string;
  violet: string;
  grid: string;
  cell: string;
  track: string;
  hm: [string, string, string, string, string];
}

export const LIGHT_PALETTE: Palette = {
  bg: '#eef1f7',
  panel: '#ffffff',
  border: '#e3e8f1',
  fg: '#0b1220',
  fg2: '#5b6678',
  fg3: '#9aa4b6',
  accent: '#0a9fc4',
  accent2: '#2f6bff',
  green: '#0a9d68',
  orange: '#ef6f1a',
  violet: '#7c5cff',
  grid: 'rgba(12,22,44,0.07)',
  cell: '#e7ebf1',
  track: '#eef1f7',
  hm: ['#e7ebf1', '#0a9fc455', '#0a9fc488', '#0a9fc4bb', '#0a9fc4'],
};

export const DARK_PALETTE: Palette = {
  bg: '#06090f',
  panel: '#0d121c',
  border: 'rgba(125,145,180,0.13)',
  fg: '#eaf0f8',
  fg2: '#9aa6b8',
  fg3: '#5c6678',
  accent: '#1fe0ff',
  accent2: '#5b9bff',
  green: '#2fe6a0',
  orange: '#ff8a4c',
  violet: '#a98bff',
  grid: 'rgba(255,255,255,0.06)',
  cell: '#121826',
  track: '#0a0e17',
  hm: ['#121826', '#1fe0ff33', '#1fe0ff66', '#1fe0ffaa', '#1fe0ff'],
};

export function getPalette(isDark: boolean): Palette {
  return isDark ? DARK_PALETTE : LIGHT_PALETTE;
}

/** Categorical series colors (donuts, multi-series), brightest first. */
export function getSeriesColors(isDark: boolean): string[] {
  const p = getPalette(isDark);
  return [p.accent, p.accent2, p.orange, p.violet, p.green, '#ff5c8a', '#ffc04d', p.fg3];
}
