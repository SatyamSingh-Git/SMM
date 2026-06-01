// Insert text (an emoji, usually) at the current cursor position of a
// textarea/input. If the element isn't focused, falls back to appending
// at the end. After mutating, restores cursor to right after the inserted
// text and refocuses the input.

export function insertAtCursor(
  el: HTMLTextAreaElement | HTMLInputElement | null,
  currentValue: string,
  insertion: string,
  setValue: (next: string) => void
): void {
  if (!el) {
    setValue(currentValue + insertion);
    return;
  }
  const start = el.selectionStart ?? currentValue.length;
  const end = el.selectionEnd ?? currentValue.length;
  const next = currentValue.slice(0, start) + insertion + currentValue.slice(end);
  setValue(next);
  // React updates the value next tick — restore caret position after that.
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    el.focus();
    const pos = start + insertion.length;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // Some input types (number, email) don't support setSelectionRange.
    }
  });
}
