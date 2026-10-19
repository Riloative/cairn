import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// The map overview repeats building names as drawing labels; text queries mean the UI.
configure({ defaultIgnore: 'script, style, svg[aria-label="Map overview"] text' });

// jsdom lacks these browser APIs used by cmdk and Radix.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
