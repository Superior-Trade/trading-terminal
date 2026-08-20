import type { MetadataRoute } from "next";

// Index the root only. The terminal is an application, not a set of pages:
// every deep route serves the same client-rendered shell, so crawling them
// creates an unbounded duplicate surface. `Allow: /$` wins over `Disallow: /`
// for the exact root by longest-match; everything else is blocked.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3200";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/$", disallow: "/" }],
    sitemap: `${SITE_URL.replace(/\/+$/, "")}/sitemap.xml`,
  };
}
