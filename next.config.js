/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: no Node.js server required. All pages render to static
  // HTML/JS/CSS in ./out for GitHub Pages hosting.
  output: 'export',

  // GitHub Pages serves the site from a project subpath and can only serve
  // static files — no image optimization server, no rewrites/redirects/headers.
  // basePath is injected at build time by GitHub Actions from the repository
  // name, so the same config works on a custom domain (empty basePath) and on
  // the default *.github.io URL.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || '',
  images: { unoptimized: true },
  trailingSlash: true,

  env: {
    // Public, non-sensitive runtime flags only. No secrets, keys or seeds are
    // ever placed here — see SECURITY.md.
    NEXT_PUBLIC_PLATFORM_VERSION: '24.0.0',
    NEXT_PUBLIC_API_GATEWAY_URL: process.env.NEXT_PUBLIC_API_GATEWAY_URL || '',
    NEXT_PUBLIC_INDEXER_URL: process.env.NEXT_PUBLIC_INDEXER_URL || ''
  }
};

module.exports = nextConfig;
