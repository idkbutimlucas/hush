import { isUiohookModifier } from './input-engine';
import { dbg } from './debug';

// How many consecutive clean polls confirm a real Fn press. The poll interval is
// ~16 ms, so 2 polls (~32 ms) also covers the reverse race where the Fn flag is
// set a hair before uiohook delivers a Fn-region key's key-down.
export const CONFIRM_POLLS = 2;

// How many consecutive clean-LOW polls are needed before we (re-)arm. macOS's
// polled fn flag is only *eventually consistent* with key events — there is a
// documented case where an unrelated mouse event momentarily resets the modifier
// flags to 0. Requiring the flag to read low for two polls means a single-poll
// glitch mid-linger can't re-arm us and fire a phantom press.
export const ARM_POLLS = 2;

// Pure state machine that decides whether the macOS Fn / Globe key is being held,
// from two signals: the Fn flag (kCGEventFlagMaskSecondaryFn, polled) and the raw
// key-down/up stream (uiohook). No native dependency, so it is unit-testable; the
// FnInputEngine adapter feeds it the live signals.
//
// The crux: the Fn / Globe key produces NO key event — EVERY other key does. But
// arrows, Page Up/Down, Home/End, Delete and F1–F12 ("Fn-region" keys) ALSO set
// the very same fn flag (they are AppKit "function keys"), and that flag is not
// perfectly synchronised with the key-up: right after releasing an arrow the flag
// can still read set for a few polls, after uiohook has already reported the
// key-up. So "flag set + no key down" is NOT enough to mean Fn — it is just the
// flag settling, and naively trusting it mutes Discord on every arrow/Delete.
//
// Fix: only a *clean rising edge* counts, and we never assume a fixed settling
// time. We must first observe an idle baseline (flag low, no key down) for a
// couple of polls to `arm`; only then does the flag going high (with no key down)
// count as a real Fn press. A settling flag never re-arms — it was already high
// when the key was released, so there is no rising edge — and it is ignored until
// it actually drops low (stably) and a genuine press raises it again.
export class FnDetector {
  private down = false;
  private armed = false; // saw a stable clean-low baseline since the last key activity
  private cleanCount = 0; // consecutive fn-high polls while armed (→ press)
  private lowCount = 0; // consecutive clean-low polls (→ arm)
  private readonly pressed = new Set<number>();

  constructor(
    private readonly onPress: () => void,
    private readonly onRelease: () => void,
    // Injectable so tests need no uiohook; production uses the real classifier.
    private readonly isModifier: (keycode: number) => boolean = isUiohookModifier,
  ) {}

  // An ordinary (non-modifier) key going down is exactly what proves a Fn-flagged
  // state is NOT the real Fn key — track those so the poll can disarm on them.
  keyDown(keycode: number): void {
    if (this.isModifier(keycode)) return;
    this.pressed.add(keycode);
  }

  keyUp(keycode: number): void {
    this.pressed.delete(keycode);
  }

  // Drive one poll tick with the current Fn-flag reading. Calls onPress/onRelease
  // at most once per tick.
  poll(fnDown: boolean): void {
    if (this.down) {
      // Release the instant the flag clears (no confirm window on the way down).
      if (!fnDown) {
        this.down = false;
        this.armed = false;
        this.cleanCount = 0;
        this.lowCount = 0;
        dbg('fn: release');
        this.onRelease();
      }
      return;
    }

    const noKeys = this.pressed.size === 0;

    if (!noKeys) {
      // A real key is physically down → whatever the flag says, it isn't Fn.
      this.armed = false;
      this.cleanCount = 0;
      this.lowCount = 0;
      return;
    }

    if (!fnDown) {
      // Clean-low baseline. Arm only once it has held for ARM_POLLS, so a lone
      // glitch poll (macOS resetting the fn flag on an unrelated event) mid-linger
      // can't re-arm us.
      this.cleanCount = 0;
      if (this.lowCount < ARM_POLLS) this.lowCount++;
      if (this.lowCount >= ARM_POLLS) this.armed = true;
      return;
    }

    // fnDown && noKeys.
    this.lowCount = 0;
    if (!this.armed) {
      // Flag is high but we never saw a stable clean-low baseline since the last
      // key was down: this is the fn flag SETTLING after a Fn-region key (arrow,
      // Delete, F-key…) was released. Ignore it — no rising edge, no press.
      this.cleanCount = 0;
      return;
    }

    this.cleanCount++;
    if (this.cleanCount >= CONFIRM_POLLS) {
      this.down = true;
      this.armed = false;
      this.cleanCount = 0;
      dbg('fn: press');
      this.onPress();
    }
  }

  // Watchdog / teardown: force everything off.
  reset(): void {
    this.down = false;
    this.armed = false;
    this.cleanCount = 0;
    this.lowCount = 0;
    this.pressed.clear();
  }
}
