import { isMac } from "@/lib/platform";
import { useRdp } from "@/stores/rdp";
import { rdpCanvas, sendInput, syncClipboard } from "./controller";
import { keyInput, toDesktop, wheelUnits } from "./keyboard";

/**
 * DOM side of an RDP tab: attaching its persistent canvas to the pane, input capture,
 * sizing and focus. Kept out of React so the canvas outlives the component.
 */

/** Attach the tab's canvas to `host` and capture its input. Returns the detach function. */
export function attachRdp(tabId: string, host: HTMLElement, title: string): () => void {
  const canvas = rdpCanvas(tabId);
  if (!canvas) return () => {};
  host.appendChild(canvas);
  canvas.tabIndex = 0;
  canvas.dataset.rdpCapture = "";
  canvas.setAttribute("aria-label", `Remote desktop ${title}`);
  canvas.className = "block outline-none";
  const mac = isMac();
  const point = (e: MouseEvent) =>
    toDesktop(e.clientX, e.clientY, canvas.getBoundingClientRect(), {
      width: canvas.width,
      height: canvas.height,
    });

  const onKey = (e: KeyboardEvent) => {
    const ui = useRdp.getState().byTab[tabId];
    if (e.type === "keydown" && e.code === "F11" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      useRdp.getState().patch(tabId, { fullscreen: !ui?.fullscreen });
      e.preventDefault();
      return;
    }
    const input = keyInput(e, { mac, cmdAsCtrl: ui?.cmdAsCtrl ?? true });
    // Every other key belongs to the remote desktop (Tab, F5, Ctrl+W…).
    e.preventDefault();
    e.stopPropagation();
    if (input) sendInput(tabId, input);
  };
  const onMove = (e: MouseEvent) => sendInput(tabId, { kind: "move", ...point(e) });
  const onButton = (e: MouseEvent) => {
    if (e.type === "mousedown") canvas.focus();
    sendInput(tabId, { kind: "move", ...point(e) });
    sendInput(tabId, { kind: "button", button: e.button, down: e.type === "mousedown" });
    e.preventDefault();
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.deltaY !== 0)
      sendInput(tabId, { kind: "wheel", vertical: true, units: wheelUnits(e.deltaY, e.deltaMode) });
    if (e.deltaX !== 0)
      sendInput(tabId, {
        kind: "wheel",
        vertical: false,
        units: -wheelUnits(e.deltaX, e.deltaMode),
      });
  };
  // Keys held while focus leaves would otherwise stay pressed on the server.
  const onBlur = () => sendInput(tabId, { kind: "releaseAll" });
  const onFocus = () => void syncClipboard(tabId);
  const noMenu = (e: Event) => e.preventDefault();

  const listeners: [string, EventListener, AddEventListenerOptions?][] = [
    ["keydown", onKey as EventListener],
    ["keyup", onKey as EventListener],
    ["mousemove", onMove as EventListener],
    ["mousedown", onButton as EventListener],
    ["mouseup", onButton as EventListener],
    ["wheel", onWheel as EventListener, { passive: false }],
    ["contextmenu", noMenu],
    ["blur", onBlur],
    ["focus", onFocus],
  ];
  for (const [type, fn, opts] of listeners) canvas.addEventListener(type, fn, opts);
  return () => {
    for (const [type, fn] of listeners) canvas.removeEventListener(type, fn);
    canvas.remove();
  };
}

/**
 * Size the canvas: "fit" keeps the aspect ratio inside `box`; "actual" maps desktop
 * pixels to device pixels. Also applies the server's cursor.
 */
export function layoutRdp(tabId: string, box: { width: number; height: number }) {
  const canvas = rdpCanvas(tabId);
  const ui = useRdp.getState().byTab[tabId];
  if (!canvas || !ui || ui.width === 0) return;
  const dpr = window.devicePixelRatio || 1;
  let w = ui.width / dpr;
  let h = ui.height / dpr;
  if (ui.scale === "fit" && box.width > 0 && box.height > 0) {
    const k = Math.min(box.width / w, box.height / h);
    w *= k;
    h *= k;
  }
  canvas.style.width = `${Math.floor(w)}px`;
  canvas.style.height = `${Math.floor(h)}px`;
  canvas.style.cursor = ui.cursor;
}

export function focusRdp(tabId: string) {
  rdpCanvas(tabId)?.focus();
}
