"use client";

/* Server-read user prefs (cg-prefs + cg-sw cookies), parsed in the ROOT
 * LAYOUT on the server and provided here so client providers can initialize
 * state to the user's saved values on the very first render — no flash of
 * english/dark/default-width before the client effect kicks in. The layout
 * also stamps <html lang/class/font-size> from the same values, so paint is
 * correct even before hydration.
 *
 * Constants/types live in server-prefs-shared.ts (server-safe module) —
 * the layout must NOT import values from this "use client" file.
 */

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_SERVER_PREFS, type ServerPrefs } from "./server-prefs-shared";

export { DEFAULT_SERVER_PREFS, type ServerPrefs } from "./server-prefs-shared";

const ServerPrefsContext = createContext<ServerPrefs>(DEFAULT_SERVER_PREFS);

export function useServerPrefs(): ServerPrefs {
  return useContext(ServerPrefsContext);
}

export function ServerPrefsProvider({
  value,
  children,
}: {
  value: ServerPrefs;
  children: ReactNode;
}) {
  return (
    <ServerPrefsContext.Provider value={value}>{children}</ServerPrefsContext.Provider>
  );
}
