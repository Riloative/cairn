/**
 * Which terminals keep a WebGL renderer. Browsers allow only ~16 WebGL contexts per
 * page and silently drop the oldest beyond that, so with many tabs Cairn keeps WebGL
 * on the most recently used terminals and lets the rest use xterm's DOM renderer.
 */

/** WebGL renderers kept at once (well under the browser limit, which other canvases share). */
export const MAX_GPU_TERMINALS = 8;

/**
 * Move `id` to the front of the most-recently-used list. Returns the new order and the
 * ids that fall off the end (to give up WebGL).
 */
export function touch(
  order: readonly string[],
  id: string,
  max = MAX_GPU_TERMINALS,
): { order: string[]; evict: string[] } {
  const next = [id, ...order.filter((x) => x !== id)];
  return { order: next.slice(0, max), evict: next.slice(max) };
}

/** Forget a closed terminal. */
export function forget(order: readonly string[], id: string): string[] {
  return order.filter((x) => x !== id);
}
