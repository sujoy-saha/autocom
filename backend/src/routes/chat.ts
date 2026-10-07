import { Router } from "express";
import multer from "multer";
import { respondToChat } from "../agents/chatBotAgent.js";
import { expensiveLimiter } from "../middleware/rateLimit.js";

export const chatRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Single endpoint backing the web chat bot widget: a free-text message, an
// optional PDF attachment (purchase order), and an optional customer
// identity. See agents/chatBotAgent.ts for the intent routing.
chatRouter.post("/", expensiveLimiter, upload.single("file"), async (req, res) => {
  const { message, customerEmail, customerName } = req.body ?? {};
  const file = req.file;

  if (!message && !file) {
    return res.status(400).json({ error: "message or file is required" });
  }

  try {
    const reply = await respondToChat({
      message: message ?? "",
      customerEmail: customerEmail || undefined,
      customerName: customerName || undefined,
      file: file ? { buffer: file.buffer, name: file.originalname } : undefined,
    });
    res.json(reply);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});
