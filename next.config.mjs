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
      // Reply Planner (2026-09-24): playbook + graded eval set are runtime-read.
      "/api/reply/draft": ["./briefs/REPLY_PLAYBOOK.md", "./briefs/tests/reply-eval-set.json"],
      "/api/reply/eval": ["./briefs/REPLY_PLAYBOOK.md", "./briefs/tests/reply-eval-set.json"],
    },
  },
};

export default nextConfig;
