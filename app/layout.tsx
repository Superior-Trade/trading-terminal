import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { DM_Sans, Space_Mono } from "next/font/google";
import Script from "next/script";
import { AppProviders } from "../components/providers";
import {
  DEFAULT_SERVER_PREFS,
  type ServerPrefs,
} from "../lib/server-prefs-shared";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});

// Share identity. SHARE_IMAGE is root-relative, so Next resolves it against
// metadataBase — set NEXT_PUBLIC_SITE_URL when you deploy this somewhere.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3200";
const SHARE_TITLE = "Trading Terminal — AI Trading Agent for Hyperliquid";
const SHARE_DESCRIPTION =
  "Describe a strategy in plain language and the terminal validates, backtests, and deploys it live on Hyperliquid. Draw a chart read, get a managed trade.";
const SHARE_IMAGE = "/social-card.png";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SHARE_TITLE,
  description: SHARE_DESCRIPTION,
  // Every route canonicalizes to the root: the app serves one identical
  // shell for all paths, so the root is the only meaningful URL for search.
  alternates: { canonical: "/" },
  icons: { icon: "/logo-dark.png" },
  openGraph: {
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
    url: SITE_URL,
    siteName: "Trading Terminal",
    images: [
      { url: SHARE_IMAGE, width: 1920, height: 1008, alt: SHARE_TITLE },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
    images: [SHARE_IMAGE],
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

// Mirrors of the i18n client constants (i18n.tsx is a client module — keep
// the server copies tiny and in sync). Dark = default, no class.
const THEME_IDS = ["dark", "light", "dracula", "nord", "tokyo"] as const;
const FONT_PX = { sm: "14px", md: "16px", lg: "17.5px" } as const;
// Per-theme app background, mirrored from globals.css. Inlined on <html> so
// the FIRST paint is already the right color — without it the browser paints
// default white until the external stylesheet arrives (the "white flash").
const THEME_BG: Record<(typeof THEME_IDS)[number], string> = {
  dark: "#000",
  light: "#ffffff",
  dracula: "#1e1f29",
  nord: "#242933",
  tokyo: "#1a1b26",
};

/** Parse cg-prefs + cg-sw cookies (written by lib/i18n.tsx / terminal-shell)
 *  so lang/theme/font-size are correct at FIRST PAINT — no english/dark
 *  flash after the user changed them. Bad cookies fall back to defaults. */
async function readServerPrefs(): Promise<ServerPrefs> {
  const prefs: ServerPrefs = { ...DEFAULT_SERVER_PREFS };
  try {
    const jar = await cookies();
    const raw = jar.get("cg-prefs")?.value;
    if (raw) {
      const p = JSON.parse(decodeURIComponent(raw)) as Partial<ServerPrefs>;
      if (p.lang === "zh" || p.lang === "en") prefs.lang = p.lang;
      if (p.theme && (THEME_IDS as readonly string[]).includes(p.theme)) {
        prefs.theme = p.theme;
      }
      if (p.fontScale && p.fontScale in FONT_PX) prefs.fontScale = p.fontScale;
    }
    const sw = parseInt(jar.get("cg-sw")?.value ?? "", 10);
    if (Number.isFinite(sw)) prefs.sidebarWidth = Math.min(700, Math.max(280, sw));
  } catch {
    /* defaults */
  }
  return prefs;
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const prefs = await readServerPrefs();
  return (
    // suppressHydrationWarning: browser extensions (Immersive Translate etc.)
    // stamp attributes on <html> before React hydrates — attribute diffs on
    // the root are expected and harmless.
    // zh-Hant, not bare "zh": the app's Chinese is Traditional, and on
    // Windows an unqualified zh makes browsers fall back to SIMPLIFIED fonts
    // (SimSun/YaHei) — a visible, uglier font change vs JhengHei.
    <html
      lang={prefs.lang === "zh" ? "zh-Hant" : "en"}
      className={`${dmSans.variable} ${spaceMono.variable}${
        prefs.theme !== "dark" ? ` ${prefs.theme}` : ""
      }`}
      style={{
        // Inline so the pre-stylesheet first paint is already theme-colored
        // (no white flash). globals.css takes over once it loads.
        backgroundColor: THEME_BG[prefs.theme],
        ...(prefs.fontScale !== "md" ? { fontSize: FONT_PX[prefs.fontScale] } : null),
      }}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <AppProviders prefs={prefs}>{children}</AppProviders>
        {/* GA4 activates only when NEXT_PUBLIC_GA_ID is set — inert until
            then, so no consent or performance cost by default. */}
        {process.env.NEXT_PUBLIC_GA_ID && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${process.env.NEXT_PUBLIC_GA_ID}`}
              strategy="afterInteractive"
            />
            <Script id="ga4-init" strategy="afterInteractive">
              {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${process.env.NEXT_PUBLIC_GA_ID}');`}
            </Script>
          </>
        )}
      </body>
    </html>
  );
}
