"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAgentId } from "@/lib/agent-id";
import styles from "./page.module.css";
import shoppingStyles from "./shopping.module.css";

export default function AgentIdModal({
  agentId,
  onSave,
  onClose,
}: {
  agentId: string;
  onSave: (agentId: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(agentId);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      pending.current?.abort();
      element?.close();
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) {
      return;
    }
    const trimmed = draft.trim();
    if (!isAgentId(trimmed)) {
      setError("Enter agt_ followed by 26 uppercase Base32 characters (A–Z, 2–7).");
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/agent-platform-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: trimmed }),
        signal: controller.signal,
      });
      if (response.status !== 200 || (await response.json()) !== true) {
        throw new Error();
      }
      if (!controller.signal.aborted) {
        onSave(trimmed);
      }
    } catch {
      if (!controller.signal.aborted) {
        setError("Unable to save Agent ID. Please try again.");
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) {
        setSaving(false);
      }
    }
  }

  return (
    <dialog
      ref={dialog}
      className={`${shoppingStyles.dialog} ${styles.agentDialog}`}
      aria-labelledby="agent-id-title"
      aria-describedby="agent-id-description"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          onClose();
        }
      }}
    >
      <h2 id="agent-id-title">Agent ID</h2>
      <p id="agent-id-description" className={styles.loginDescription}>
        For this demo, simply paste the Agent ID from your Hashtrion Wallet to use it during
        checkout.
      </p>
      <form className={styles.loginForm} onSubmit={save}>
        <label htmlFor="agent-id-input">Agent ID</label>
        <input
          id="agent-id-input"
          autoFocus
          disabled={saving}
          value={draft}
          placeholder="agt_..."
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error ? "agent-id-error" : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
        />
        {error && (
          <p id="agent-id-error" className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.agentDialogActions}>
          <button type="button" className={styles.newChat} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.send} disabled={saving} aria-busy={saving}>
            {saving && <span className={styles.saveSpinner} aria-hidden="true" />}
            {saving ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
