import { dbg } from './debug';

// The macOS Fn / Globe key is a hardware "secondary function" modifier — it is
// NOT reported as a key event by uiohook (or most input libs). But its state is
// exposed by CoreGraphics' CGEventSourceFlagsState, a pure state query (no event
// tap, no special permission), which we call via FFI and poll. This is the only
// reliable way to mirror a Wispr Flow push-to-talk bound to Fn (Wispr's default).

const FN_MASK = 0x800000n; // kCGEventFlagMaskSecondaryFn
const HID_STATE = 1; // kCGEventSourceStateHIDSystemState

let flagsState: ((stateId: number) => number | bigint) | null = null;
let loaded = false;

function ensure(): void {
  if (loaded) return;
  loaded = true;
  if (process.platform !== 'darwin') return;
  try {
    // koffi is a prebuilt N-API FFI — no compilation, ABI-stable under Electron.
    const koffi = require('koffi');
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    flagsState = cg.func('uint64 CGEventSourceFlagsState(int stateId)');
    dbg('fn: CoreGraphics loaded (Fn polling available)');
  } catch (err) {
    flagsState = null;
    dbg('fn: CoreGraphics load failed', err instanceof Error ? err.message : String(err));
  }
}

// Whether Fn detection is usable on this machine (macOS + FFI loaded).
export function fnAvailable(): boolean {
  ensure();
  return flagsState !== null;
}

// True while the Fn / Globe key is physically held.
export function isFnDown(): boolean {
  ensure();
  if (!flagsState) return false;
  try {
    const raw = flagsState(HID_STATE);
    const flags = typeof raw === 'bigint' ? raw : BigInt(raw);
    return (flags & FN_MASK) !== 0n;
  } catch {
    return false;
  }
}
