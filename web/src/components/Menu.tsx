import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { menuKeyAction, openFocusIndex } from "../menu-keys.ts";

// Shared overflow ("더 보기") menu: a trigger button and a popover list (.menu-list/.menu-item).
// Keyboard: Enter/Space/↓/↑ open (focus goes to the first/last item), ↑↓ wrap, Home/End jump,
// Esc closes and returns focus to the trigger, Tab closes and moves on. A click outside closes it.

export type MenuItem = { label: string; icon: IconName; danger?: boolean } & ({ run: () => void; href?: undefined } | { href: string; run?: () => void });

export function Menu({ label, items, icon = "more-horizontal" }: { label: string; items: MenuItem[]; icon?: IconName }) {
  const [open, setOpen] = useState<false | "first" | "last">(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const els = list.current?.querySelectorAll<HTMLElement>("[role=menuitem]");
    if (els) els[openFocusIndex(open, els.length)]?.focus();
    const onDown = (ev: MouseEvent) => {
      if (!wrap.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const onKey = (ev: KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    const action = menuKeyAction(ev.key, i, els.length);
    if (!action) return;
    if ("focus" in action) {
      ev.preventDefault();
      els[action.focus]?.focus();
    } else if (action.close === "refocus") {
      // Esc: stop here, since the graph drawer and the mobile sidebar also close on a window-level Esc.
      ev.preventDefault();
      ev.stopPropagation();
      close();
    } else {
      close(false);
    }
  };

  return (
    <div className="menu" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="btn menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        onClick={() => (open ? setOpen(false) : setOpen("first"))}
        onKeyDown={(ev) => {
          if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && !open) {
            ev.preventDefault();
            setOpen(ev.key === "ArrowUp" ? "last" : "first");
          }
        }}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div className="menu-list" role="menu" aria-label={label} ref={list} onKeyDown={onKey}>
          {items.map((it) => {
            const cls = `menu-item${it.danger ? " danger" : ""}`;
            const body = (
              <>
                <Icon name={it.icon} size={14} />
                {it.label}
              </>
            );
            return it.href !== undefined ? (
              <a key={it.label} role="menuitem" tabIndex={-1} className={cls} href={it.href} onClick={() => (close(), it.run?.())}>
                {body}
              </a>
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={cls}
                onClick={() => {
                  close();
                  it.run();
                }}
              >
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
