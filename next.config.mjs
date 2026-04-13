import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: __dirname,

  // Compress output for smaller bundles
  compress: true,

  // Optimize production builds
  productionBrowserSourceMaps: false,

  async headers() {
    return [
      {
        // Precomputed static replay JSON — rebuild on each deploy, 1h browser cache
        source: "/replay/:file*.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }
        ]
      },
      {
        // Static assets - aggressive caching (1 year, immutable for hashed files)
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" }
        ]
      },
      {
        // Main page - short cache with SWR for instant reloads
        source: "/",
        headers: [
          { key: "Cache-Control", value: "public, max-age=60, stale-while-revalidate=3600" }
        ]
      }
    ];
  }
};

export default nextConfig;
