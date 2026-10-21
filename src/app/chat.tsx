"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  isChatHistory,
  MAX_CONVERSATION_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES,
  type ChatMessage,
} from "@/lib/chat";
import { isDiscoveryReport } from "@/lib/discovery-types";
import { isCatalogReport } from "@/lib/catalog-types";
import { mergeCatalogPage } from "@/lib/catalog-display";
import { maskAgentId } from "@/lib/agent-id";
import { CatalogResults, ShoppingSources } from "./shopping-results";
import ShoppingContext from "./shopping-context";
import {
  uncertainPaymentView,
  PAYMENT_OUTCOME_UNKNOWN_NOTICE,
  type ShoppingAction,
  type ShoppingView,
} from "@/lib/shopping";
import AgentIdModal from "./agent-id-modal";
import { refreshShoppingStatus, ShoppingRefreshError } from "@/lib/shopping-refresh";
import Login from "./login";
import styles from "./page.module.css";

const STORAGE_KEY = "hashtrion-chat-v1";

export default function Chat() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [loadingPage, setLoadingPage] = useState<number | null>(null);
  const [pageError, setPageError] = useState<{ index: number; message: string } | null>(null);
  const [sessionEnded, setSessionEnded] = useState<string | null>(null);
  // Demo identity stays in memory across chats; a page refresh intentionally clears it.
  const [agentId, setAgentId] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [shopping, setShopping] = useState<ShoppingView>();
  const [agentIdOpen, setAgentIdOpen] = useState(false);
  const [refreshingCheckout, setRefreshingCheckout] = useState(false);
  const [checkoutRefreshError, setCheckoutRefreshError] = useState("");
  const pending = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const focusAfterUpdate = useRef<{ origin: Element | null } | null>(null);
  const agentIdTrigger = useRef<Element | null>(null);

  useEffect(() => {
    // Restore browser-only storage after hydration, before enabling submission.
    const frame = requestAnimationFrame(() => {
      try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (
            isChatHistory(parsed, MAX_CONVERSATION_LENGTH + MAX_MESSAGE_LENGTH) &&
            parsed.length % 2 === 0
          ) {
            setMessages(parsed);
            if (parsed.some((message) => message.catalog)) {
              setStorageWarning(
                "Chat history restored. Search again before selecting or buying a previously shown product."
              );
            }
          } else {
            setStorageWarning("Saved chat could not be restored. A new chat has started.");
          }
        }
      } catch {
        setStorageWarning(
          "Session storage is unavailable. Chat history may not survive a refresh."
        );
      }
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [messages, loading, error]);

  function save(history: ChatMessage[]) {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          history.map(({ role, content, catalog, discovery }) => ({
            role,
            content,
            catalog,
            discovery,
          }))
        )
      );
    } catch {
      setStorageWarning("Chat history could not be saved and may be lost on refresh.");
    }
  }

  function endSession(notice: string) {
    setAgentId("");
    setConversationId(undefined);
    setShopping(undefined);
    setAgentIdOpen(false);
    setMessages([]);
    setInput("");
    setError("");
    setStorageWarning("");
    setPageError(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Storage may be unavailable. */
    }
    setSessionEnded(notice);
    router.refresh();
  }

  async function logout() {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setLoggingOut(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok && response.status !== 401) {
        throw new Error("logout_failed");
      }
      endSession("You have signed out.");
    } catch {
      setError("Unable to sign out. Please check your connection and try again.");
    } finally {
      pending.current = false;
      setLoggingOut(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !ready || !input.trim()) {
      return;
    }
    await sendMessage(input.trim());
  }

  async function sendMessage(content: string, action?: ShoppingAction) {
    if (pending.current || !ready) {
      return;
    }
    const next: ChatMessage[] = [
      ...(action ? messages.slice(-(MAX_MESSAGES - 2)) : messages),
      { role: "user", content },
    ];
    // Keep checkout controls usable at the text-history limit; server state remains authoritative.
    if (action) {
      while (next.length > 1 && !Boolean(isChatHistory(next))) {
        next.splice(0, 2);
      }
    }
    if (!isChatHistory(next)) {
      setError("This conversation has reached its limit. Start a new chat to continue.");
      return;
    }
    focusAfterUpdate.current = { origin: document.activeElement };
    pending.current = true;
    setLoading(true);
    setError("");
    setMessages(next);
    setInput("");
    if (action?.type === "confirm" || action?.type === "retry") {
      setShopping((current) =>
        current
          ? {
              ...current,
              stage: "processing",
              confirmation: undefined,
              canCancel: false,
              canRetry: false,
              retryUnavailableReason: undefined,
              paymentStatus: undefined,
              checkout: current.checkout
                ? { ...current.checkout, paymentStatus: undefined }
                : undefined,
              notice: "Submitting payment. Waiting for the merchant's response.",
            }
          : current
      );
    }
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.map(({ role, content }) => ({ role, content })),
          ...(agentId ? { agentId } : {}),
          conversationId,
          action,
          confirmation: shopping?.confirmation,
        }),
        signal: AbortSignal.timeout(100_000),
      });
      if (response.status === 401) {
        endSession("Your session expired. Sign in again to continue.");
        return;
      }
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Unable to send your message. Please try again."
        );
      }
      if (
        data.message?.role !== "assistant" ||
        typeof data.message.content !== "string" ||
        !data.message.content.trim() ||
        data.message.content.length > MAX_MESSAGE_LENGTH
      ) {
        throw new Error("The server returned an invalid reply. Please try again.");
      }
      if (data.message.discovery !== undefined && !isDiscoveryReport(data.message.discovery)) {
        throw new Error("The server returned invalid discovery evidence. Please try again.");
      }
      if (data.message.catalog !== undefined && !isCatalogReport(data.message.catalog)) {
        throw new Error("The server returned invalid product results. Please try again.");
      }
      setConversationId(data.conversationId);
      setShopping(data.message.shopping);
      setCheckoutRefreshError("");
      const completed: ChatMessage[] = [
        ...next,
        {
          role: "assistant",
          content: data.message.content,
          ...(data.message.discovery ? { discovery: data.message.discovery } : {}),
          ...(data.message.catalog ? { catalog: data.message.catalog } : {}),
        },
      ];
      setMessages(completed);
      save(completed);
    } catch (cause) {
      setMessages(messages);
      if (action?.type === "confirm" || action?.type === "retry") {
        setShopping((current) => (current ? uncertainPaymentView(current) : current));
        setInput("");
        setError(PAYMENT_OUTCOME_UNKNOWN_NOTICE);
      } else {
        setInput(content);
        setError(
          cause instanceof Error && cause.name === "Error"
            ? cause.message
            : "The request timed out or the connection was lost. Please try again."
        );
      }
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }

  function openAgentId() {
    agentIdTrigger.current = document.activeElement;
    setAgentIdOpen(true);
  }

  async function saveAgentId(value: string) {
    if (pending.current) {
      return;
    }
    focusAfterUpdate.current = { origin: agentIdTrigger.current };
    setAgentId(value);
    setAgentIdOpen(false);
    setCheckoutRefreshError("");
    // Never enable purchase using a confirmation bound to the previous identity.
    setShopping((current) => (current ? { ...current, confirmation: undefined } : current));
    if (!conversationId || !shopping?.checkout) {
      return;
    }
    pending.current = true;
    setRefreshingCheckout(true);
    try {
      const updated = await refreshShoppingStatus(
        conversationId,
        shopping.checkout.id,
        value,
        AbortSignal.timeout(30_000)
      );
      setShopping(updated);
    } catch (cause) {
      if (cause instanceof ShoppingRefreshError && cause.status === 401) {
        endSession("Your session expired. Sign in again to continue.");
      } else {
        setCheckoutRefreshError(
          "Agent ID saved. Checkout could not be refreshed. Use Check status before confirming."
        );
      }
    } finally {
      pending.current = false;
      setRefreshingCheckout(false);
    }
  }

  async function newChat() {
    if (pending.current) {
      return;
    }
    focusAfterUpdate.current = { origin: document.activeElement };
    pending.current = true;
    setLoading(true);
    try {
      if (conversationId) {
        const response = await fetch(
          `/api/chat?conversationId=${encodeURIComponent(conversationId)}`,
          { method: "DELETE", signal: AbortSignal.timeout(15_000) }
        );
        if (!response.ok) {
          throw new Error("reset_failed");
        }
      }
      setConversationId(undefined);
      setShopping(undefined);
      setMessages([]);
      setInput("");
      setError("");
      setStorageWarning("");
      setPageError(null);
      save([]);
    } catch {
      setError("Could not start a new chat. Please try again after the current request finishes.");
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }

  async function loadMore(index: number) {
    const report = messages[index]?.catalog;
    if (
      pending.current ||
      !report?.continuation ||
      !report.pagination?.hasNextPage ||
      !report.pagination.cursor
    ) {
      return;
    }
    pending.current = true;
    setLoadingPage(index);
    setPageError(null);
    try {
      const response = await fetch("/api/catalog/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuation: report.continuation, conversationId }),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 401) {
        endSession("Your session expired. Sign in again to continue.");
        return;
      }
      const data = await response.json();
      if (!response.ok || !isCatalogReport(data.catalog) || data.catalog.status !== "completed") {
        throw new Error("page_failed");
      }
      const catalog = mergeCatalogPage(report, data.catalog);
      const updated = messages.map((message, messageIndex) =>
        messageIndex === index ? { ...message, catalog } : message
      );
      setMessages(updated);
      save(updated);
    } catch {
      setPageError({
        index,
        message:
          "More products could not be loaded. Please try again, or search again if the problem continues.",
      });
    } finally {
      pending.current = false;
      setLoadingPage(null);
    }
  }

  const busy = loading || loggingOut || loadingPage !== null || refreshingCheckout;
  const atLimit =
    messages.length >= MAX_MESSAGES ||
    messages.reduce((sum, message) => sum + message.content.length, 0) >= MAX_CONVERSATION_LENGTH;

  useEffect(() => {
    if (busy || agentIdOpen || !ready || !focusAfterUpdate.current) {
      return;
    }
    // Wait for the enabled textarea and modal focus restoration to commit.
    const frame = requestAnimationFrame(() => {
      const request = focusAfterUpdate.current;
      focusAfterUpdate.current = null;
      const element = textarea.current;
      const active = document.activeElement;
      if (
        !request || !element || element.disabled || active === element ||
        document.querySelector("dialog[open]") ||
        (active && active !== document.body && active !== request.origin)
      ) {
        return;
      }
      element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [agentIdOpen, atLimit, busy, messages, ready, shopping]);

  if (sessionEnded !== null) {
    return <Login notice={sessionEnded} />;
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.mark} aria-hidden="true">
              <svg
                width="23"
                height="23"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 7h14l1 14H4L5 7Z" />
                <path d="M8 8V6a4 4 0 0 1 8 0v2" />
              </svg>
            </span>
            <div>
              <h1>AI Shopping Agent</h1>
              <p>Search, discover, and shop.</p>
            </div>
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.newChat}
              disabled={busy || !ready}
              onClick={() => void newChat()}
            >
              New chat
            </button>
            <button
              type="button"
              className={`${styles.newChat} ${styles.agentButton}`}
              disabled={busy || !ready}
              aria-haspopup="dialog"
              onClick={openAgentId}
            >
              Agent ID{agentId && <span>{maskAgentId(agentId)}</span>}
            </button>
            <button className={styles.newChat} disabled={busy} onClick={logout}>
              {loggingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </header>
        <section
          className={styles.conversation}
          role="log"
          aria-label="Chat conversation"
          aria-live="polite"
          aria-busy={loading || loadingPage !== null}
        >
          {messages.length === 0 && (
            <div className={styles.empty}>
              <span className={styles.eyebrow}>LET’S FIND SOMETHING</span>
              <h2>What are you shopping for?</h2>
              <p>Find products</p>
            </div>
          )}
          {messages.map((message, index) => {
            return (
              <article
                key={index}
                className={`${styles.message} ${message.role === "user" ? styles.user : styles.assistant} ${message.catalog ? styles.shoppingMessage : ""}`}
              >
                <span className={styles.role}>{message.role === "user" ? "You" : "Assistant"}</span>
                <p>{message.content}</p>
                {message.catalog && (
                  <CatalogResults
                    report={message.catalog}
                    onLoadMore={() => void loadMore(index)}
                    loading={loadingPage === index}
                    disabled={busy}
                    error={pageError?.index === index ? pageError.message : undefined}
                  />
                )}
                {message.discovery && <ShoppingSources report={message.discovery} />}
              </article>
            );
          })}
          {shopping && (
            <ShoppingContext
              value={shopping}
              agentId={agentId}
              disabled={busy}
              refreshing={refreshingCheckout}
              refreshError={checkoutRefreshError}
              onAgentId={openAgentId}
              onAction={(action) =>
                void sendMessage(
                  action.type === "confirm"
                    ? "Confirm the purchase."
                    : action.type === "retry"
                      ? "Try the payment again after updating my Wallet spending limit."
                      : action.type === "cancel"
                        ? "Cancel my checkout."
                        : "Check my checkout status.",
                  action
                )
              }
            />
          )}
          {loading && (
            <div className={styles.thinking} role="status">
              <span className={styles.thinkingDots} aria-hidden="true">
                <span className={styles.dot} />
                <span className={styles.dot} />
                <span className={styles.dot} />
              </span>
              <span>{shopping?.stage === "processing" ? "Processing payment…" : "Thinking…"}</span>
            </div>
          )}
          <div ref={bottom} />
        </section>
        <footer className={styles.footer}>
          {storageWarning && (
            <p className={styles.notice} role="status">
              {storageWarning}
            </p>
          )}
          {atLimit && (
            <p className={styles.notice}>
              Conversation limit reached. Start a new chat to continue.
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <form className={styles.composer} onSubmit={send}>
            <label className={styles.srOnly} htmlFor="message">
              Message
            </label>
            <textarea
              aria-describedby="message-help"
              id="message"
              ref={textarea}
              value={input}
              maxLength={MAX_MESSAGE_LENGTH}
              rows={2}
              placeholder="Message Shopping Agent…"
              disabled={busy || !ready || atLimit}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              className={styles.send}
              type="submit"
              disabled={busy || !ready || atLimit || !input.trim()}
            >
              {loading ? "Sending…" : "Send ↑"}
            </button>
          </form>
          <p id="message-help" className={styles.srOnly}>
            Enter to send. Shift + Enter for a new line. Do not share passwords or wallet secrets.
          </p>
          {input.length >= MAX_MESSAGE_LENGTH * 0.9 && (
            <div className={styles.hint} role="status">
              {input.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}
            </div>
          )}
        </footer>
      </div>
      {agentIdOpen && (
        <AgentIdModal
          agentId={agentId}
          onClose={() => setAgentIdOpen(false)}
          onSave={(value) => void saveAgentId(value)}
        />
      )}
    </main>
  );
}
