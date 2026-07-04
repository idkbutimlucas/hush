import { uIOhook } from 'uiohook-napi';
import { InputEngine } from './types';
import { fnAvailable, isFnDown } from './fn-key';
import { FnDetector } from './fn-detector';

const POLL_MS = 16; // ~60 Hz — snappy, and a CGEventSourceFlagsState call is cheap.

interface UiohookEvent { keycode: number }

// InputEngine that fires press/release on the Fn / Globe key. Fn produces no key
// event, so we poll its flag; but arrow / navigation / Delete / F-keys share that
// flag and leave it lingering after release, so we also feed uiohook's raw key
// stream to the FnDetector, which rejects everything but a clean Fn rising edge.
// Same contract as the uiohook engine, so the orchestrator wiring is identical.
export class FnInputEngine implements InputEngine {
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pressCb: () => void = () => {};
  private releaseCb: () => void = () => {};

  private readonly detector = new FnDetector(
    () => this.pressCb(),
    () => this.releaseCb(),
  );

  private readonly onKeyDown: (e: UiohookEvent) => void;
  private readonly onKeyUp: (e: UiohookEvent) => void;

  constructor() {
    this.onKeyDown = (e) => this.detector.keyDown(e.keycode);
    this.onKeyUp = (e) => this.detector.keyUp(e.keycode);
  }

  onPress(cb: () => void): void { this.pressCb = cb; }
  onRelease(cb: () => void): void { this.releaseCb = cb; }

  start(): void {
    if (!fnAvailable()) throw new Error('Fn detection unavailable on this platform');
    if (this.started) return;
    uIOhook.on('keydown', this.onKeyDown);
    uIOhook.on('keyup', this.onKeyUp);
    uIOhook.start();
    this.started = true;
    this.timer = setInterval(() => this.detector.poll(isFnDown()), POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    uIOhook.off('keydown', this.onKeyDown);
    uIOhook.off('keyup', this.onKeyUp);
    try { uIOhook.stop(); } catch { /* already stopped */ }
    this.started = false;
    this.detector.reset();
  }
}
