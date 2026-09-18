'use client';

import { useEffect } from 'react';

/**
 * Registers `public/sw.js` with the build sha as its cache version. In `next dev` the
 * chunks under `/_next/static` are not immutable, so a cache-first worker would serve
 * stale code: the worker is registered in production builds only, and any worker a
 * previous production build left on this origin is unregistered so a dev session never
 * runs behind it.
 */
export function ServiceWorkerRegistration({ version, enabled = process.env.NODE_ENV === 'production' }: { version: string; enabled?: boolean }) {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (!enabled) {
      void navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) void registration.unregister();
      });
      return;
    }
    navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(version)}`, { scope: '/' }).catch(() => {
      // A browser that refuses the worker (private mode, an insecure context) still gets the online app; nothing to do.
    });
  }, [version, enabled]);
  return null;
}

/** Ask the worker to forget the pages it cached for this session (sign-out on a shared phone). */
export function clearCachedPages(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.controller?.postMessage({ type: 'clear-pages' });
}
