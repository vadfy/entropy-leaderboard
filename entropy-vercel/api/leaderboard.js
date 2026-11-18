import { createLeaderboardProxy } from '../lib/leaderboard-proxy.js';

// Vercel's Node.js Web Handler receives every method; the proxy accepts GET only.
export default { fetch: createLeaderboardProxy() };
