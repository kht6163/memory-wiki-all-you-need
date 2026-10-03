import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, type IconName } from "./Icon.tsx";

// Module-level toast store: `toast()` works anywhere (no hooks), and toasts survive route changes.

export type ToastKind = "ok" | "error" | "info";
export interface ToastOptions {
  kind?: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; run: () => void };
  /** ms; ok/info default 4000, errors stay until closed. */
  duration?: number;
}
interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(opts: ToastOptions): number {
  const id = nextId++;
  items = [...items, { ...opts, kind: opts.kind ?? "info", id }];
  emit();
  return id;
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const MAX_VISIBLE = 3;
const KIND_ICON: Record<ToastKind, IconName> = { ok: "check", error: "circle-alert", info: "info" };

/** Renders the toast stack. Mount once, outside <main>, so it stays interactive while main is inert. */
export function ToastProvider() {
  const list = useSyncExternalStore(subscribe, () => items);
  const visible = list.slice(-MAX_VISIBLE);
  return (
    <div className="toast-region" role="region" aria-label="알림">
      {visible.map((t) => (
        <ToastView key={t.id} t={t} />
      ))}
    </div>
  );
}

function ToastView({ t }: { t: ToastItem }) {
  const [paused, setPaused] = useState(false);
  const duration = t.duration ?? (t.kind === "error" ? 0 : 4000);
  const left = useRef(duration);

  useEffect(() => {
    if (!duration || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(t.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(500, left.current - (Date.now() - started));
    };
  }, [duration, paused, t.id]);

  return (
    <div
      className={`toast toast-${t.kind}`}
      role={t.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-icon">
        <Icon name={KIND_ICON[t.kind]} />
      </span>
      <div className="toast-text">
        <div className="toast-title">{t.title}</div>
        {t.description && <div className="toast-desc">{t.description}</div>}
      </div>
      {t.action && (
        <button
          className="btn small"
          onClick={() => {
            t.action!.run();
            dismissToast(t.id);
          }}
        >
          {t.action.label}
        </button>
      )}
      <button className="icon-btn" aria-label="알림 닫기" onClick={() => dismissToast(t.id)}>
        <Icon name="x" />
      </button>
    </div>
  );
}
