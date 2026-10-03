// Keyboard model of the shared overflow menu (components/Menu.tsx), kept free of DOM/React so it
// can be tested from server/test.

export type MenuKeyAction = { focus: number } | { close: "refocus" | "move-on" } | null;

/** Which item gets focus when the menu opens from the trigger: ↑ opens on the last, anything else on the first. */
export function openFocusIndex(how: "first" | "last", count: number): number {
  return count <= 0 ? -1 : how === "last" ? count - 1 : 0;
}

/**
 * What a key pressed inside the open list does. `current` is the focused item's index (-1 if none).
 * ↑↓ wrap, Home/End jump, Esc closes and returns focus to the trigger, Tab closes and lets focus move on.
 */
export function menuKeyAction(key: string, current: number, count: number): MenuKeyAction {
  if (key === "Escape") return { close: "refocus" };
  if (key === "Tab") return { close: "move-on" };
  if (count <= 0) return null;
  if (key === "ArrowDown") return { focus: current < 0 ? 0 : (current + 1) % count };
  if (key === "ArrowUp") return { focus: current < 0 ? count - 1 : (current + count - 1) % count };
  if (key === "Home") return { focus: 0 };
  if (key === "End") return { focus: count - 1 };
  return null;
}
