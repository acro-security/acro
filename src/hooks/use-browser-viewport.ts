import { useLayoutEffect, type RefObject } from "react";
import { Browser } from "@/browser";
import { native } from "@/api";

// Keep mount/unmount viewport updates ordered across asynchronous IPC calls,
// and only send the latest placement: while the slot moves, a queue of stale
// placements would trail the page behind the layout, which reads as damping.
let queued: Parameters<typeof Browser.setViewport>[0] | null = null;
let draining = false;
function place(input: Parameters<typeof Browser.setViewport>[0]) {
  queued = input;
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        await Browser.setViewport(next);
      }
    } catch {
      // A failed placement is retried by the next measurement.
    } finally {
      draining = false;
    }
  })();
}

/** Place the native guest WebView in the measured React content slot. */
export function useBrowserViewport(
  ref: RefObject<HTMLDivElement | null>,
  tabId?: string,
  suspended = false,
) {
  useLayoutEffect(() => {
    if (!native) return;
    let frame = 0;
    let previous = "";
    let disposed = false;
    const update = () => {
      frame = 0;
      if (disposed) return;
      const el = ref.current;
      const rect = el?.getBoundingClientRect();
      let left = Math.max(0, rect?.left ?? 0),
        top = Math.max(0, rect?.top ?? 0);
      let right = Math.min(window.innerWidth, rect?.right ?? 0),
        bottom = Math.min(window.innerHeight, rect?.bottom ?? 0);
      for (let parent = el?.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
      const width = Math.max(0, right - left),
        height = Math.max(0, bottom - top);
      const overlay = document.querySelector(
        '[data-slot="dialog-content"], [data-slot="select-content"], [data-slot="popover-content"], [data-slot="context-menu-content"]',
      );
      const visible =
        !!tabId && !suspended && !overlay && !document.hidden && !!rect && width > 0 && height > 0;
      const input = {
        tabId: tabId ?? "",
        visible,
        clientWidth: window.innerWidth,
        clientHeight: window.innerHeight,
        x: left,
        y: top,
        width,
        height,
      };
      const key = JSON.stringify(input);
      if (key !== previous) {
        previous = key;
        place(input);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    if (ref.current) resize.observe(ref.current);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    update();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      place({
        tabId: "",
        visible: false,
        clientWidth: window.innerWidth,
        clientHeight: window.innerHeight,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    };
  }, [ref, tabId, suspended]);
}
