import { Combo, Mod } from './types';

const MOD_ORDER: Mod[] = ['ctrl', 'alt', 'cmd', 'shift'];

export function normalizeMods(mods: Mod[]): Mod[] {
  return MOD_ORDER.filter((m) => mods.includes(m));
}

export function comboEquals(a: Combo, b: Combo): boolean {
  if (a.key.toUpperCase() !== b.key.toUpperCase()) return false;
  const na = normalizeMods(a.mods);
  const nb = normalizeMods(b.mods);
  return na.length === nb.length && na.every((m, i) => m === nb[i]);
}

export function combosDistinct(combos: Combo[]): boolean {
  for (let i = 0; i < combos.length; i++) {
    for (let j = i + 1; j < combos.length; j++) {
      if (comboEquals(combos[i], combos[j])) return false;
    }
  }
  return true;
}

const MOD_SYMBOL: Record<Mod, string> = { ctrl: '⌃', alt: '⌥', cmd: '⌘', shift: '⇧' };

// The macOS Fn / Globe key, stored as key === 'Fn' with no modifiers.
export function isFnCombo(combo: Combo): boolean {
  return combo.mods.length === 0 && combo.key.toUpperCase() === 'FN';
}

export function comboLabel(combo: Combo): string {
  if (isFnCombo(combo)) return '🌐 Fn';
  const mods = normalizeMods(combo.mods).map((m) => MOD_SYMBOL[m]).join('');
  if (!combo.key) return mods || '—';
  return mods + combo.key.toUpperCase();
}
