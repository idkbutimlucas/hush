import { InputEngine } from './types';
import { fnAvailable, isFnDown } from './fn-key';
import { dbg } from './debug';

const POLL_MS = 16; // ~60 Hz — snappy, and a CGEventSourceFlagsState call is cheap.

// InputEngine that fires press/release on the Fn / Globe key by polling its
// state (Fn produces no key event to listen for). Same contract as the uiohook
// engine, so the orchestrator wiring is identical.
export class FnInputEngine implements InputEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private down = false;
  private pressCb: () => void = () => {};
  private releaseCb: () => void = () => {};

  onPress(cb: () => void): void { this.pressCb = cb; }
  onRelease(cb: () => void): void { this.releaseCb = cb; }

  start(): void {
    if (!fnAvailable()) throw new Error('Fn detection unavailable on this platform');
    if (this.timer) return;
    this.down = isFnDown();
    this.timer = setInterval(() => {
      const now = isFnDown();
      if (now === this.down) return;
      this.down = now;
      if (now) { dbg('fn: press'); this.pressCb(); }
      else { dbg('fn: release'); this.releaseCb(); }
    }, POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.down = false;
  }
}
