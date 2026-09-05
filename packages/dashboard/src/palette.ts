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
  bg: '#fbfcfe',
  panel: '#ffffff',
  border: '#e4eaf2',
  fg: '#101828',
  fg2: '#50627c',
  fg3: '#8b9ab1',
  accent: '#1677ff',
  accent2: '#4f6df5',
  green: '#04b86f',
  orange: '#ff9a6a',
  violet: '#6d69f2',
  grid: 'rgba(80,98,124,0.14)',
  cell: '#edf2f8',
  track: '#edf2f8',
  hm: ['#edf2f8', '#d7eaff', '#9fd3f7', '#5fb7eb', '#167bc4'],
};

export const DARK_PALETTE: Palette = {
  bg: '#0e141d',
  panel: '#151d28',
  border: 'rgba(157,177,210,0.16)',
  fg: '#eef4fb',
  fg2: '#a8b5c7',
  fg3: '#74839a',
  accent: '#6ea5ff',
  accent2: '#8a98ff',
  green: '#42d99a',
  orange: '#ffad84',
  violet: '#a99cff',
  grid: 'rgba(221,232,248,0.12)',
  cell: '#202b3a',
  track: '#202b3a',
  hm: ['#202b3a', 'rgba(110,165,255,0.28)', 'rgba(110,165,255,0.48)', 'rgba(110,165,255,0.72)', '#6ea5ff'],
};

export function getPalette(isDark: boolean): Palette {
  return isDark ? DARK_PALETTE : LIGHT_PALETTE;
}

/** Categorical series colors (donuts, multi-series), ordered by visual weight. */
export function getSeriesColors(isDark: boolean): string[] {
  const p = getPalette(isDark);
  return [p.accent, p.accent2, p.orange, p.violet, p.green, '#ff5c8a', '#f1b35d', p.fg3];
}
