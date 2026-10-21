"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

export default function Login({ notice }: { notice?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const pending = useRef(false);
  const busy = loading || refreshing;

  useEffect(() => {
    // Clear any chat from a previous or expired session before the next login.
    try {
      sessionStorage.removeItem("hashtrion-chat-v1");
    } catch {
      /* Storage may be unavailable. */
    }
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || refreshing || !password) {
      return;
    }
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        startTransition(() => router.refresh());
      } else if (response.status === 401) {
        setError("Incorrect password. Please try again.");
      } else if (response.status === 429) {
        setError("Too many login attempts. Please wait a few minutes before trying again.");
      } else if (response.status === 503) {
        setError("Access is not configured. Please contact the hackathon organizer.");
      } else {
        setError("Unable to sign in. Please try again.");
      }
    } catch {
      setError("Unable to sign in. Please check your connection and try again.");
    } finally {
      setPassword("");
      pending.current = false;
      setLoading(false);
    }
  }

  return (
    <main className={`${styles.page} ${styles.loginPage}`}>
      <section className={styles.loginCard} aria-labelledby="login-title">
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
            <h1 id="login-title">Shopping Agent</h1>
          </div>
        </div>
        <h2>Welcome back</h2>
        <p className={styles.loginDescription} id="login-description">
          Enter the access password.
        </p>
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className={styles.error} id="login-error" role="alert">
            {error}
          </p>
        )}
        <form className={styles.loginForm} onSubmit={login} aria-busy={busy}>
          <label htmlFor="access-password">Access password</label>
          <input
            id="access-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            maxLength={1024}
            required
            disabled={busy}
            aria-describedby={error ? "login-description login-error" : "login-description"}
            onChange={(event) => {
              setPassword(event.target.value);
              setError("");
            }}
          />
          <button className={styles.send} type="submit" disabled={busy || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
