/* Server-safe prefs constants — NO "use client" here: the root layout (a
 * server component) imports these, and values imported from client modules
 * degrade to client-reference proxies server-side (spread to {}). The client
 * context lives in server-prefs.tsx and re-exports from here. */

export interface ServerPrefs {
  lang: "en" | "zh";
  theme: "dark" | "light" | "dracula" | "nord" | "tokyo";
  fontScale: "sm" | "md" | "lg";
  /** Chart/setups divider position (px). Null = never resized. */
  sidebarWidth: number | null;
}

export const DEFAULT_SERVER_PREFS: ServerPrefs = {
  lang: "en",
  theme: "dark",
  fontScale: "md",
  sidebarWidth: null,
};
