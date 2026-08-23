import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The private parent workspace owns agent instructions. Do not generate
  // public-repo AGENTS.md/CLAUDE.md files during local development.
  agentRules: false,
};

export default nextConfig;
