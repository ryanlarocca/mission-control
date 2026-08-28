/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // The regenerate route reads briefs/CAMPAIGN_VOICE.md at runtime (compose
  // prompt voice rules); Vercel only ships traced files.
  experimental: {
    outputFileTracingIncludes: {
      "/api/campaign/sends/[id]/regenerate": ["./briefs/CAMPAIGN_VOICE.md", "./scripts/campaign-compose.mjs"],
      "/api/campaign/regenerate-batch": ["./briefs/CAMPAIGN_VOICE.md", "./scripts/campaign-compose.mjs"],
    },
  },
};

export default nextConfig;
