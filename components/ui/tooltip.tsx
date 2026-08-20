"use client";

/* Lightweight, dependency-free hover/focus tooltip. Renders its content in a
 * fixed-position portal on document.body so it escapes overflow/stacking
 * contexts (needed inside the indicator menu, which itself is a portal). Opens
 * on hover AND keyboard focus for a11y; positions on the given side with a
 * viewport-clamped flip. Theme-aware via CSS variables / prefers-color-scheme.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type Side = "top" | "right" | "bottom" | "left";

export function Tooltip({
  content,
  children,
  side = "right",
  openDelay = 120,
  maxWidth = 300,
  block = false,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  openDelay?: number;
  maxWidth?: number;
  /** Stretch the anchor to full width (block) instead of shrinking to its
   * content — needed when the trigger is a full-width row. */
  block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const place = useCallback(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    const t = tipRef.current?.getBoundingClientRect();
    if (!a) return;
    const tw = t?.width ?? maxWidth;
    const th = t?.height ?? 0;
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    // Preferred side, then flip if it would clip.
    const wantLeft = side === "left" && a.left - gap - tw < 4;
    const effSide: Side =
      side === "right" && a.right + gap + tw > vw - 4
        ? "left"
        : wantLeft
          ? "right"
          : side;
    switch (effSide) {
      case "left":
        left = a.left - gap - tw;
        top = a.top + a.height / 2 - th / 2;
        break;
      case "top":
        left = a.left + a.width / 2 - tw / 2;
        top = a.top - gap - th;
        break;
      case "bottom":
        left = a.left + a.width / 2 - tw / 2;
        top = a.bottom + gap;
        break;
      default: // right
        left = a.right + gap;
        top = a.top + a.height / 2 - th / 2;
    }
    left = Math.max(4, Math.min(left, vw - tw - 4));
    top = Math.max(4, Math.min(top, vh - th - 4));
    setPos({ left, top });
  }, [side, maxWidth]);

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), openDelay);
  }, [openDelay]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);

  // Re-place once mounted (so we can measure the real tooltip size) and on
  // scroll/resize while open.
  useEffect(() => {
    if (!open) return;
    place();
    const on = () => place();
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
    };
  }, [open, place]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <span
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={open ? id : undefined}
      style={
        block
          ? { display: "block", width: "100%" }
          : { display: "inline-flex", alignItems: "center" }
      }
    >
      {children}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            style={{
              position: "fixed",
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              zIndex: 2147483000,
              maxWidth,
              pointerEvents: "none",
              opacity: pos ? 1 : 0,
              transition: "opacity .1s ease",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
