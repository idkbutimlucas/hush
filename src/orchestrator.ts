import { DiscordMuter, HushConfig } from './types';
import { WisprGesture, GestureDeps } from './gesture';
import { dbg } from './debug';

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Hush's whole job: while you hold your push-to-talk shortcut (which Wispr
// listens to natively), mute your Discord mic — and unmute on release. It never
// touches Wispr; it only drives the Discord RPC mute.
export class Orchestrator {
  private active = false;
  // Whether the user was already self-muted in Discord at the moment Hush
  // muted. If so, releasing push-to-talk must leave them muted rather than
  // unmuting them (they didn't ask to be unmuted).
  private mutedBefore = false;
  // Presses/releases fire from the global hook as fire-and-forget callbacks, and
  // each mute/unmute is async (an RPC round-trip). Serialize them through this
  // tail so a release can't overtake the mute it's meant to undo.
  private queue: Promise<void> = Promise.resolve();
  // In hands-free mode a gesture recognizer turns taps/holds/double-taps into
  // activate/deactivate; in hold/toggle modes it stays null.
  private readonly gesture: WisprGesture | null;

  constructor(
    private readonly discord: DiscordMuter,
    private readonly cfg: HushConfig,
    private readonly onActiveChange?: (active: boolean) => void,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
    gestureDeps?: GestureDeps,
  ) {
    this.gesture =
      cfg.mode === 'auto'
        ? new WisprGesture(
            () => void this.enqueue(() => this.activate()),
            () => void this.enqueue(() => this.deactivate()),
            {},
            gestureDeps,
          )
        : null;
  }

  // Await all queued mute/unmute transitions — for deterministic tests.
  whenIdle(): Promise<void> {
    return this.queue;
  }

  // Chain a transition onto the queue; keep the chain alive even if one throws so
  // a single failed transition can't wedge every later press/release.
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  async onPress(): Promise<void> {
    if (this.gesture) { this.gesture.press(); return; }
    return this.enqueue(() =>
      this.cfg.mode === 'hold'
        ? this.activate()
        : this.active
          ? this.deactivate()
          : this.activate(),
    );
  }

  async onRelease(): Promise<void> {
    if (this.gesture) { this.gesture.release(); return; }
    return this.enqueue(() => (this.cfg.mode === 'hold' ? this.deactivate() : Promise.resolve()));
  }

  async forceRelease(): Promise<void> {
    if (this.gesture) { this.gesture.reset(); return; }
    return this.enqueue(() => (this.active ? this.deactivate() : Promise.resolve()));
  }

  isActive(): boolean {
    return this.active;
  }

  private setActive(value: boolean): void {
    this.active = value;
    this.onActiveChange?.(value);
  }

  private async activate(): Promise<void> {
    if (this.active) return;
    // Snapshot the pre-existing Discord mute so release can restore it. Unknown
    // (null) → treat as not-muted, i.e. keep the old unmute-on-release behavior.
    this.mutedBefore = (await this.discord.getMute?.()) === true;
    dbg('orchestrator: activate (mute)', { mutedBefore: this.mutedBefore });
    this.setActive(true);
    await this.discord.setMute(true);
  }

  private async deactivate(): Promise<void> {
    if (!this.active) return;
    this.setActive(false);
    if (this.mutedBefore) {
      // They were already muted before Hush touched it — leave them muted.
      dbg('orchestrator: deactivate (stay muted — was muted before)');
      return;
    }
    dbg('orchestrator: deactivate (unmute)');
    if (this.cfg.unmuteDelayMs > 0) await this.sleep(this.cfg.unmuteDelayMs);
    await this.discord.setMute(false);
  }
}
