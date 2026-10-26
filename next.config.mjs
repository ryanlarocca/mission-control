/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // The regenerate route reads briefs/CAMPAIGN_VOICE.md at runtime (compose
  // prompt voice rules); Vercel only ships traced files.
  experimental: {
    // ws must load from node_modules unbundled: webpack breaks its optional
    // bufferutil hook ("t.mask is not a function" on the first send) — hit by
    // the voice-test opener sideband 2026-10-25.
    serverComponentsExternalPackages: ["ws"],
    outputFileTracingIncludes: {
      "/api/campaign/sends/[id]/regenerate": ["./briefs/CAMPAIGN_VOICE.md", "./scripts/campaign-compose.mjs"],
      "/api/campaign/regenerate-batch": ["./briefs/CAMPAIGN_VOICE.md", "./scripts/campaign-compose.mjs"],
      // Reply Planner (2026-09-24): playbook + graded eval set are runtime-read.
      "/api/reply/draft": ["./briefs/REPLY_PLAYBOOK.md", "./briefs/tests/reply-eval-set.json"],
      "/api/reply/coach": ["./briefs/REPLY_PLAYBOOK.md", "./briefs/tests/reply-eval-set.json"],
      "/api/reply/eval": ["./briefs/REPLY_PLAYBOOK.md", "./briefs/tests/reply-eval-set.json"],
    },
  },
};

export default nextConfig;
