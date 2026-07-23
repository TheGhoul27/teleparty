import type { NextConfig } from "next";

const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL ?? "http://localhost:4000";
const signalingWs = signalingUrl.replace(/^http/, "ws");

const isDev = process.env.NODE_ENV !== "production";

/**
 * Strict CSP. `unsafe-inline` for styles is required by Next.js style
 * injection; scripts stay locked down in production. Development additionally
 * needs `unsafe-eval` because the Next.js dev runtime (react-refresh, eval'd
 * source maps) uses eval - without it client JS never hydrates.
 *
 * connect-src: in production the signaling server address comes from
 * NEXT_PUBLIC_SIGNALING_URL. In development the client derives it from
 * whatever host served the page (localhost, LAN IP, Tailscale address), which
 * cannot be enumerated ahead of time - so dev allows any http(s)/ws(s) target.
 * Dev also permits the Google Fonts stylesheets requested by the Next.js dev
 * overlay so the console stays free of CSP noise.
 */
const connectSrc = isDev
  ? "connect-src 'self' http: https: ws: wss:"
  : `connect-src 'self' ${signalingUrl} ${signalingWs}`;

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  `style-src 'self' 'unsafe-inline'${isDev ? " https://fonts.googleapis.com" : ""}`,
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  connectSrc,
  `font-src 'self'${isDev ? " https://fonts.gstatic.com" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const nextConfig: NextConfig = {
  transpilePackages: ["@watchshare/shared"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), display-capture=(self), microphone=(self)" }
        ]
      }
    ];
  }
};

export default nextConfig;
