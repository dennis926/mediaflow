import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface PullToRefresh {
  /** Attach to the scrollable content wrapper. */
  ref: RefObject<HTMLDivElement>;
  /** Current pull offset in px, for the visual indicator. */
  distance: number;
  refreshing: boolean;
}

/**
 * Minimal pull-to-refresh for the mobile shell.
 * The page scrolls the document (not the wrapper), so the gesture only starts
 * while `window.scrollY === 0`. Listeners are passive: the native rubber-band
 * effect is kept, we only mirror the distance in state.
 */
export function usePullToRefresh(onRefresh: () => void | Promise<void>, options?: { threshold?: number }): PullToRefresh {
  const threshold = options?.threshold ?? 64;
  const ref = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const distanceRef = useRef(0);
  const refreshRef = useRef(onRefresh);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  const reset = useCallback(() => {
    startY.current = null;
    distanceRef.current = 0;
    setDistance(0);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const handleStart = (event: TouchEvent) => {
      if (refreshing || event.touches.length !== 1) return;
      if (window.scrollY > 0) {
        startY.current = null;
        return;
      }
      startY.current = event.touches[0].clientY;
    };

    const handleMove = (event: TouchEvent) => {
      if (startY.current === null || refreshing) return;
      const delta = event.touches[0].clientY - startY.current;
      if (delta <= 0) {
        if (distanceRef.current !== 0) {
          distanceRef.current = 0;
          setDistance(0);
        }
        return;
      }
      // Damped movement keeps the gesture feeling native.
      const next = Math.min(delta * 0.5, threshold * 1.5);
      distanceRef.current = next;
      setDistance(next);
    };

    const handleEnd = () => {
      if (startY.current === null) return;
      const pulled = distanceRef.current;
      startY.current = null;
      distanceRef.current = 0;
      if (pulled < threshold || refreshing) {
        setDistance(0);
        return;
      }
      setRefreshing(true);
      setDistance(threshold);
      void Promise.resolve(refreshRef.current())
        .catch(() => undefined)
        .finally(() => {
          setRefreshing(false);
          setDistance(0);
        });
    };

    element.addEventListener('touchstart', handleStart, { passive: true });
    element.addEventListener('touchmove', handleMove, { passive: true });
    element.addEventListener('touchend', handleEnd, { passive: true });
    element.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      element.removeEventListener('touchstart', handleStart);
      element.removeEventListener('touchmove', handleMove);
      element.removeEventListener('touchend', handleEnd);
      element.removeEventListener('touchcancel', reset);
    };
  }, [refreshing, reset, threshold]);

  return { ref, distance, refreshing };
}
