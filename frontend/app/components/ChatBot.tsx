"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/apiClient";

interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  orderId?: string;
}

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "bot",
  text:
    "Hi, I'm Ace, your AutoCom assistant. Upload a purchase-order PDF, tell me what to order " +
    "in plain English, or ask about an existing order's status/tracking.",
};

export function ChatBot({
  onOrderSelected,
  defaultEmail,
}: {
  onOrderSelected?: (orderId: string) => void;
  /** Prefills the customer-email field from the signed-in dashboard user, if any. */
  defaultEmail?: string;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [email, setEmail] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("chatbot_email");
    setEmail(saved || defaultEmail || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultEmail]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  async function send() {
    if (!input.trim() && !file) return;
    const userText = file ? `${input.trim() ? `${input.trim()} ` : ""}📎 ${file.name}` : input.trim();
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", text: userText };
    setMessages((m) => [...m, userMessage]);
    setInput("");
    setSending(true);

    if (email) window.localStorage.setItem("chatbot_email", email);

    try {
      const formData = new FormData();
      formData.append("message", input.trim());
      if (email) formData.append("customerEmail", email);
      if (file) formData.append("file", file);

      const res = await apiFetch(`/api/chat`, { method: "POST", body: formData });
      const data = await res.json();

      const botMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "bot",
        text: res.ok ? data.message : (data.error ?? "Something went wrong."),
        orderId: data.orderId,
      };
      setMessages((m) => [...m, botMessage]);
      if (data.orderId) onOrderSelected?.(data.orderId);
    } catch {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "bot", text: "I couldn't reach the backend — is it running?" },
      ]);
    } finally {
      setFile(null);
      setSending(false);
    }
  }

  return (
    <div className="chatbot-root">
      {open && (
        <div className="chatbot-panel">
          <div className="chatbot-header">
            <div className="chatbot-header-identity">
              <span className="chatbot-avatar" aria-hidden="true">
                ✨
              </span>
              <span>Ace — Order Assistant</span>
            </div>
            <button type="button" className="chatbot-close" onClick={() => setOpen(false)} aria-label="Close chat">
              ×
            </button>
          </div>

          <div className="chatbot-email-row">
            <input
              type="email"
              placeholder="Your email (for placing orders)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="chatbot-messages" ref={scrollRef}>
            {messages.map((m) => (
              <div key={m.id} className={`chatbot-bubble chatbot-bubble-${m.role}`}>
                {m.text}
                {m.orderId && onOrderSelected && (
                  <button type="button" className="chatbot-view-order" onClick={() => onOrderSelected(m.orderId!)}>
                    View order →
                  </button>
                )}
              </div>
            ))}
            {sending && (
              <div className="chatbot-bubble chatbot-bubble-bot chatbot-typing">
                Ace is thinking
                <span className="chatbot-typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            )}
          </div>

          <div className="chatbot-input-row">
            {file && (
              <div className="chatbot-file-chip">
                📎 {file.name}
                <button type="button" onClick={() => setFile(null)} aria-label="Remove attachment">
                  ×
                </button>
              </div>
            )}
            <div className="chatbot-input-controls">
              <label className="chatbot-attach" title="Attach a purchase-order PDF">
                📎
                <input
                  type="file"
                  accept="application/pdf"
                  hidden
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <input
                type="text"
                placeholder="Ask me to place an order, or check a status…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !sending) send();
                }}
              />
              <button type="button" onClick={send} disabled={sending || (!input.trim() && !file)}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      <button type="button" className="chatbot-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Close" : "✨ Ask Ace"}
      </button>
    </div>
  );
}
