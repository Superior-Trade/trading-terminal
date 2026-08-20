import type { MetadataRoute } from "next";

// One URL: the root. Deep routes are app state, not pages.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3200";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: SITE_URL, lastModified: new Date() }];
}
