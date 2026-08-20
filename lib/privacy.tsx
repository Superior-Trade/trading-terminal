"use client";

/* Privacy mode (screen-share safety): one global flag that hides every money
 * amount in the UI. Percentages stay visible — % without $ doesn't expose
 * account size. Toggled from the header eye button; persists per browser.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "cg-privacy";

const PrivacyContext = createContext<{ hidden: boolean; toggle: () => void }>({
  hidden: false,
  toggle: () => {},
});

export function usePrivacy() {
  return useContext(PrivacyContext);
}

export function PrivacyProvider({ children }: { children: ReactNode }) {
  // SSR-safe: first render is always "visible" (matches server HTML), the
  // saved flag applies in an effect. No flash risk — every masked amount is
  // client-fetched and renders after hydration anyway.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setHidden(true);
    } catch {
      /* storage unavailable — session-only toggle */
    }
  }, []);

  const toggle = () =>
    setHidden((h) => {
      const next = !h;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  return (
    <PrivacyContext.Provider value={{ hidden, toggle }}>
      {children}
    </PrivacyContext.Provider>
  );
}

/** Renders `value` normally, or a fixed-width dot mask when privacy is on.
 *  font-mono keeps the mask's metrics stable inside non-mono parents. */
export function Masked({ value }: { value: ReactNode }) {
  const { hidden } = usePrivacy();
  if (!hidden) return <>{value}</>;
  return <span className="font-mono">•••••</span>;
}
