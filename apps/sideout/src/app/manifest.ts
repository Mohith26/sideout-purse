import type { MetadataRoute } from 'next';

/**
 * The web app manifest (spec 5.3: installable PWA). Colours are the base background token
 * from `packages/ui/src/styles/tokens.css` as a literal, because the manifest cannot read
 * CSS; `test/pwa/manifest.test.ts` pins it to the token. The icons are static files under
 * `public/icons`.
 */
export const MANIFEST_THEME = '#08090b';
export const MANIFEST_BACKGROUND = '#08090b';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sideout',
    short_name: 'Sideout',
    description: 'Charity beach volleyball tournaments: live play, standings, and what every event raises.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: MANIFEST_BACKGROUND,
    theme_color: MANIFEST_THEME,
    categories: ['sports'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
