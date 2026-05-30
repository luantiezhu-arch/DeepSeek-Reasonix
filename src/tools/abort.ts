/** Shared AbortSignal helpers — ensures consistent cleanup across all tools. */

/**
 * Wire ctx.signal into a local AbortController.
 * Returns a cleanup function that MUST be called in a finally block.
 * Usage:
 *   const ac = new AbortController();
 *   const cleanup = wireAbort(ctx?.signal, ac);
 *   try { ... } finally { cleanup(); }
 */
export function wireAbort(
  parentSignal: AbortSignal | undefined,
  child: AbortController,
): () => void {
  if (parentSignal?.aborted) {
    child.abort();
    return () => {};
  }
  if (!parentSignal) return () => {};
  const onAbort = () => child.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });
  return () => parentSignal.removeEventListener("abort", onAbort);
}

/**
 * Create an AbortController with a hard timeout.
 * Returns { controller, timer, cleanup }.
 * cleanup() clears both the timer and parent wiring.
 */
export function withTimeout(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const unwire = wireAbort(parentSignal, controller);
  const cleanup = () => {
    clearTimeout(timer);
    unwire();
  };
  return { controller, cleanup };
}
