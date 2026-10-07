import rateLimit from "express-rate-limit";

// General ceiling for all API traffic -- generous enough for normal
// dashboard polling/Realtime use, just there to blunt abuse or a runaway
// client-side loop from exhausting the server or the underlying Supabase
// project.
export const standardLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Tighter ceiling for endpoints that either trigger an LLM call (Nemotron
// via Nebius Token Factory costs real credits per call) or perform a bulk
// destructive write -- PO/text order intake, the chat bot, and the
// "delete all orders" admin action.
export const expensiveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests to this endpoint -- please slow down." },
});
