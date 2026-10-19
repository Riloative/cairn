let audio: AudioContext | null = null;

/** Short, soft beep (WebAudio; no bundled sound file needed). */
export function beep() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.15);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.15);
  } catch {
    // Audio may be unavailable; the bell is best-effort.
  }
}

/** Briefly flash an element (visual bell). */
export function flash(el: HTMLElement) {
  el.animate([{ backgroundColor: "rgb(255 255 255 / 0.12)" }, { backgroundColor: "transparent" }], {
    duration: 180,
    easing: "ease-out",
  });
}
