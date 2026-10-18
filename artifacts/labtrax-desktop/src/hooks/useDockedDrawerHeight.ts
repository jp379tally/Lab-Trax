import { useLayoutEffect, useRef } from "react";

/** A docked panel can start below page headings, not at the viewport's top. */
export function useDockedDrawerHeight(docked: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!docked || !panel) return;
    const measure = () => {
      const top = Math.max(16, panel.getBoundingClientRect().top);
      const height = `${Math.max(0, window.innerHeight - top - 16)}px`;
      if (panel.style.getPropertyValue("--case-drawer-height") !== height) {
        panel.style.setProperty("--case-drawer-height", height);
      }
    };
    measure();
    // Capture nested shell scrolling as well as window scrolling.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    if (panel.parentElement) observer.observe(panel.parentElement);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      observer.disconnect();
      panel.style.removeProperty("--case-drawer-height");
    };
  }, [docked]);

  return ref;
}
