let blockedUntil = -Infinity;

// Shared by every task completion control, even when a row disappears or moves.
export function acceptCompletionToggle(): boolean {
  const now = performance.now();
  if (now < blockedUntil) return false;
  blockedUntil = now + 400;
  return true;
}
