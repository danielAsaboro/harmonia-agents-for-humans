import { getGoals, listRecentEngagement } from "@/lib/repository";
import { internalTenantHandler } from "@/lib/internalAuth";

/** Cross-job reaction insights + operator goals the agent injects into ideation. */
async function get(_req: Request) {
  const [insights, goals] = await Promise.all([listRecentEngagement(), getGoals()]);
  const measuredInsights = insights.filter((insight) => insight.availability === "available" && insight.metrics !== null);
  const totals = measuredInsights.reduce(
    (acc, i) => ({
      posts: acc.posts + 1,
      likes: acc.likes + (i.metrics?.likes ?? 0),
      reposts: acc.reposts + (i.metrics?.reposts ?? 0),
      replies: acc.replies + (i.metrics?.replies ?? 0),
    }),
    { posts: 0, likes: 0, reposts: 0, replies: 0 },
  );
  return Response.json({
    totals,
    topPosts: [...measuredInsights, ...insights.filter((insight) => insight.availability === "unavailable")].slice(0, 5),
    goals,
  });
}

export const GET = internalTenantHandler(get);
