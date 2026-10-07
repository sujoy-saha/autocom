import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { ordersRouter } from "./routes/orders.js";
import { chatRouter } from "./routes/chat.js";
import { inventoryRouter } from "./routes/inventory.js";
import { restockRouter } from "./routes/restock.js";
import { invoicesRouter } from "./routes/invoices.js";
import { meRouter } from "./routes/me.js";
import { requireAuth } from "./middleware/auth.js";
import { standardLimiter } from "./middleware/rateLimit.js";

const app = express();

// Restrict cross-origin access by setting ALLOWED_ORIGINS (comma-separated)
// to your deployed frontend URL(s), e.g. https://your-app.vercel.app. Left
// unset, all origins are allowed -- the same wide-open default this project
// has always used for local/demo development, so an existing local setup
// keeps working without this variable.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  })
);
if (allowedOrigins.length === 0) {
  console.warn(
    "[config] ALLOWED_ORIGINS not set: accepting requests from any origin. " +
      "Set ALLOWED_ORIGINS to your deployed frontend URL(s) (e.g. your Vercel " +
      "domain) before going to production."
  );
}

app.use(express.json());
app.use(standardLimiter);

app.get("/health", (_req, res) =>
  res.json({ status: "ok", demoMode: config.isDemoMode, isDemoStore: config.isDemoStore, isDemoLlm: config.isDemoLlm })
);
// Every /api/* route requires a valid Supabase session token once a real
// Supabase project is configured (see middleware/auth.ts's requireAuth for
// the zero-config demo-mode bypass).
app.use("/api/orders", requireAuth, ordersRouter);
app.use("/api/chat", requireAuth, chatRouter);
app.use("/api/inventory", requireAuth, inventoryRouter);
app.use("/api/restock-orders", requireAuth, restockRouter);
app.use("/api/invoices", requireAuth, invoicesRouter);
app.use("/api/me", requireAuth, meRouter);

app.listen(config.port, () => {
  console.log(`AutoCom backend listening on http://localhost:${config.port}`);
  console.log(`Store: ${config.isDemoStore ? "in-memory (demo)" : "Supabase (live)"}`);
  console.log(`LLM:   ${config.isDemoLlm ? "canned/heuristic (demo)" : "Nemotron via Nebius (live)"}`);
});
