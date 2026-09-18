'use client';

import { useEffect, useState } from 'react';

/**
 * Whether this phone can reach Sideout right now, from the browser's `online`/`offline`
 * events and `navigator.onLine` (which covers a page that opened from the service worker's
 * cache while already offline, where no event fires). Reads online on the server and
 * during hydration, so the first render never claims a state it cannot know.
 */
export function useConnectivity(): { offline: boolean } {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const read = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    read();
    window.addEventListener('online', read);
    window.addEventListener('offline', read);
    return () => {
      window.removeEventListener('online', read);
      window.removeEventListener('offline', read);
    };
  }, []);
  return { offline: !online };
}
