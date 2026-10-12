import type { Status } from '@msp/engine';

/**
 * Two themes:
 *  - field: dark, high-contrast, readable in a stand at dawn without blowing night vision.
 *  - redlight: Hunt mode. Black + red only; status relies on ICON + brightness, never hue alone.
 */
export interface Theme {
  name: 'field' | 'redlight';
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textDim: string;
  accent: string;
  accentText: string;
  danger: string;
  status: Record<Status, string>;
  dial: { good: string; caution: string; bad: string };
  route: { entry: string; exit: string };
  wind: string;
  thermal: string;
  map: { bedding: string; food: string; corridor: string; stand: string; standSelected: string };
}

export const fieldTheme: Theme = {
  name: 'field',
  bg: '#0E1110',
  surface: '#181D1B',
  surfaceAlt: '#222826',
  border: '#33403A',
  text: '#F1F4EF',
  textDim: '#A9B4AD',
  accent: '#E8792B', // blaze orange
  accentText: '#111111',
  danger: '#FF5A4F',
  status: { safe: '#4CC27A', caution: '#F2B33D', avoid: '#FF5A4F' },
  dial: { good: '#4CC27A', caution: '#F2B33D', bad: '#FF5A4F' },
  route: { entry: '#7FD4FF', exit: '#C99BFF' },
  wind: '#F1F4EF',
  thermal: '#7FD4FF',
  map: { bedding: '#A0522D', food: '#C9D46A', corridor: '#F2B33D', stand: '#E8792B', standSelected: '#FFFFFF' },
};

export const redlightTheme: Theme = {
  name: 'redlight',
  bg: '#000000',
  surface: '#120000',
  surfaceAlt: '#1C0303',
  border: '#3A0A0A',
  text: '#FF4A3D',
  textDim: '#A3281F',
  accent: '#FF2A1A',
  accentText: '#000000',
  danger: '#FF7A6E',
  // Same hue family; status is carried by the icon (✓ / ! / ✕) and brightness.
  status: { safe: '#B3241A', caution: '#E0362A', avoid: '#FF7A6E' },
  dial: { good: '#7A170F', caution: '#C02A1F', bad: '#FF6A5E' },
  route: { entry: '#FF4A3D', exit: '#A3281F' },
  wind: '#FF4A3D',
  thermal: '#A3281F',
  map: { bedding: '#5A0F0A', food: '#3A0A0A', corridor: '#7A170F', stand: '#FF2A1A', standSelected: '#FF8A7E' },
};

/** Glove-friendly minimum touch target. */
export const TOUCH = 56;
export const RADIUS = 14;
export const SPACE = 12;

export const font = {
  xl: 28,
  lg: 21,
  md: 17,
  sm: 14,
  xs: 12,
};
