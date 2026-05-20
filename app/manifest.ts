import type { MetadataRoute } from "next";

export const dynamic = "force-dynamic";

type WebAppProtocolHandler = {
  protocol: string;
  url: string;
};

type ExtendedManifest = MetadataRoute.Manifest & {
  protocol_handlers?: WebAppProtocolHandler[];
  launch_handler?: {
    client_mode?: "navigate-existing" | "auto" | "focus-existing" | "navigate-new"
      | Array<"navigate-existing" | "auto" | "focus-existing" | "navigate-new">;
  };
};

// Manifest paths must include the deployment subpath - browsers resolve them
// against the document origin, not the manifest's location, and Next.js does
// not auto-prefix string literals inside MetadataRoute payloads.
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
const withBase = (p: string) => `${BASE_PATH}${p}`;

export default function manifest(): ExtendedManifest {
  const appName =
    process.env.APP_NAME ||
    process.env.NEXT_PUBLIC_APP_NAME ||
    "Bulwark Webmail";

  const shortName = process.env.APP_SHORT_NAME || appName;
  const description =
    process.env.APP_DESCRIPTION ||
    "A modern webmail client built for Stalwart Mail Server";
  const themeColor = process.env.PWA_THEME_COLOR || "#ffffff";
  const backgroundColor = process.env.PWA_BACKGROUND_COLOR || "#ffffff";

  // If PWA_ICON_URL or FAVICON_URL is configured, serve dynamically resized PNGs
  // via /api/pwa-icon/[size]. Otherwise fall back to the default Bulwark PNGs.
  const hasCustomIcon = !!(process.env.PWA_ICON_URL || process.env.FAVICON_URL);

  const icons: MetadataRoute.Manifest["icons"] = hasCustomIcon
    ? [
        { src: withBase("/api/pwa-icon/192"), sizes: "192x192", type: "image/png", purpose: "any" },
        { src: withBase("/api/pwa-icon/512"), sizes: "512x512", type: "image/png", purpose: "any" },
        { src: withBase("/api/pwa-icon/192"), sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: withBase("/api/pwa-icon/512"), sizes: "512x512", type: "image/png", purpose: "maskable" },
      ]
    : [
        { src: withBase("/icon-192x192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
        { src: withBase("/icon-512x512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
        { src: withBase("/icon-maskable-light-192x192.png"), sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: withBase("/icon-maskable-light-512x512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
        { src: withBase("/icon-maskable-dark-192x192.png"), sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: withBase("/icon-maskable-dark-512x512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
      ];

  return {
    name: appName,
    short_name: shortName,
    description,
    start_url: withBase("/"),
    scope: withBase("/"),
    display: "standalone",
    orientation: "portrait-primary",
    theme_color: themeColor,
    background_color: backgroundColor,
    icons,
    categories: ["productivity"],
    screenshots: [
      { src: withBase("/screenshot-540x720.png"), sizes: "540x720", type: "image/png" },
      { src: withBase("/screenshot-1280x720.png"), sizes: "1280x720", type: "image/png" },
    ],
    protocol_handlers: [
      { protocol: "mailto", url: withBase("/protocol/mailto?url=%s") },
      { protocol: "webcal", url: withBase("/protocol/webcal?url=%s") },
    ],
    launch_handler: {
      client_mode: ["focus-existing", "navigate-new"],
    },
  };
}
