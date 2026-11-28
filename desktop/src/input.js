'use strict';
// Taking over a paired PC (docs/remote-pc.md, "Taking control"): mouse and keyboard from an RFB viewer,
// turned into real input on this PC.
//
// Windows: one long-lived PowerShell child that compiles a small C# class calling user32 SendInput and
// reads one event per line from stdin. Nothing native is bundled, and the child runs at the app's own
// (never elevated) level, so Windows' UIPI keeps it out of elevated windows and the UAC prompt.
// Elsewhere (tests and development on Linux) xdotool stands in.
//
// The mapping from RFB to input is pure and tested (tests/remote-core.test.mjs): pointer button masks to
// press/release, wheel bits to scroll, keysyms to virtual keys or Unicode characters. Whatever is held
// down when control ends is released, so a dropped connection never leaves a key or button stuck.

const { spawn } = require('node:child_process');

// X11 keysym -> [Windows virtual key, extended?]
const VK = {
  0xff08: [0x08], 0xff09: [0x09], 0xff0d: [0x0d], 0xff1b: [0x1b], 0xffff: [0x2e, 1], 0xff13: [0x13], 0xff14: [0x91], 0xff61: [0x2c, 1],
  0xff50: [0x24, 1], 0xff51: [0x25, 1], 0xff52: [0x26, 1], 0xff53: [0x27, 1], 0xff54: [0x28, 1], 0xff55: [0x21, 1], 0xff56: [0x22, 1], 0xff57: [0x23, 1], 0xff63: [0x2d, 1],
  0xffe1: [0xa0], 0xffe2: [0xa1], 0xffe3: [0xa2], 0xffe4: [0xa3, 1], 0xffe9: [0xa4], 0xffea: [0xa5, 1], 0xffe7: [0x5b, 1], 0xffe8: [0x5c, 1], 0xffeb: [0x5b, 1], 0xffec: [0x5c, 1],
  0xffe5: [0x14], 0xff7f: [0x90, 1], 0xff67: [0x5d, 1], 0xfe03: [0xa5, 1],
  0xff8d: [0x0d, 1], 0xffaa: [0x6a], 0xffab: [0x6b], 0xffad: [0x6d], 0xffae: [0x6e], 0xffaf: [0x6f, 1],
};
for (let i = 0; i < 12; i++) VK[0xffbe + i] = [0x70 + i]; // F1..F12
for (let i = 0; i < 10; i++) VK[0xffb0 + i] = [0x60 + i]; // keypad 0..9
const MODIFIERS = new Set([0xffe3, 0xffe4, 0xffe9, 0xffea, 0xffe7, 0xffe8, 0xffeb, 0xffec, 0xfe03]); // Ctrl, Alt, Meta, Super, AltGr

/** A keysym's character, or null for keys that are not characters. */
function keysymChar(ks) {
  if ((ks >= 0x20 && ks <= 0x7e) || (ks >= 0xa0 && ks <= 0xff)) return ks;
  if (ks >= 0x01000000 && ks <= 0x0110ffff) return ks - 0x01000000;
  return null;
}

/**
 * Turns RFB events into a list of plain input actions:
 *   { t: 'move', x, y }           x, y as fractions 0..1 of the screen
 *   { t: 'button', b, down }      b: 'left' | 'middle' | 'right'
 *   { t: 'wheel', dy } / { t: 'wheel', dx }   in notches (+1 = up / right)
 *   { t: 'vk', vk, ext, down } / { t: 'char', code, down, viaKey }
 * viaKey: a modifier such as Ctrl is held, so the character goes as its key (Ctrl+C must be a shortcut).
 */
class InputMapper {
  constructor() { this.mask = 0; this.held = new Map(); this.mods = new Set(); this.last = null; }

  pointer(mask, x, y, width, height) {
    const out = [];
    const fx = Math.max(0, Math.min(1, x / Math.max(1, width - 1)));
    const fy = Math.max(0, Math.min(1, y / Math.max(1, height - 1)));
    if (!this.last || this.last.x !== fx || this.last.y !== fy) { out.push({ t: 'move', x: fx, y: fy }); this.last = { x: fx, y: fy }; }
    const changed = mask ^ this.mask;
    [['left', 1], ['middle', 2], ['right', 4]].forEach(([b, bit]) => { if (changed & bit) out.push({ t: 'button', b, down: !!(mask & bit) }); });
    // Wheel "buttons" are pressed and released for each notch; count the presses.
    const pressed = mask & ~this.mask;
    if (pressed & 8) out.push({ t: 'wheel', dy: 1 });
    if (pressed & 16) out.push({ t: 'wheel', dy: -1 });
    if (pressed & 32) out.push({ t: 'wheel', dx: -1 });
    if (pressed & 64) out.push({ t: 'wheel', dx: 1 });
    this.mask = mask;
    return out;
  }

  key(down, ks) {
    if (MODIFIERS.has(ks)) { if (down) this.mods.add(ks); else this.mods.delete(ks); }
    let action = null;
    const mapped = VK[ks];
    if (mapped) action = { t: 'vk', vk: mapped[0], ext: !!mapped[1] };
    else {
      const code = keysymChar(ks);
      if (code === null) return [];
      action = { t: 'char', code, viaKey: this.mods.size > 0 };
    }
    // Release what was actually pressed for this keysym, even if the modifiers changed in between.
    if (!down) {
      const pressed = this.held.get(ks);
      if (!pressed) return [];
      this.held.delete(ks);
      return [{ ...pressed, down: false }];
    }
    this.held.set(ks, action);
    return [{ ...action, down: true }];
  }

  /** Everything still held, let go. */
  releaseAll() {
    const out = [...this.held.values()].map((a) => ({ ...a, down: false }));
    [['left', 1], ['middle', 2], ['right', 4]].forEach(([b, bit]) => { if (this.mask & bit) out.push({ t: 'button', b, down: false }); });
    this.held.clear(); this.mods.clear(); this.mask = 0;
    return out;
  }
}

// ---------- Windows: SendInput through PowerShell ----------
const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
public static class CleftInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char c);
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(int x, int y, int data, uint flags) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = x; i.u.mi.dy = y; i.u.mi.mouseData = unchecked((uint)data); i.u.mi.dwFlags = flags; Send(i);
  }
  public static void Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; Send(i);
  }
  public static void Char(int code, bool down, bool viaKey) {
    uint up = down ? 0u : 2u; // KEYEVENTF_KEYUP
    if (viaKey && code < 0x10000) {
      short s = VkKeyScanW((char)code);
      if (s != -1) { Key((ushort)(s & 0xff), 0, up); return; }
    }
    string text = char.ConvertFromUtf32(code);
    foreach (char c in text) Key(0, (ushort)c, 4u | up); // KEYEVENTF_UNICODE
  }
}`;
const PS_LOOP = `
Add-Type -TypeDefinition @'
${CSHARP}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'M' { [CleftInput]::Mouse([int]$p[1], [int]$p[2], [int]$p[3], [uint32]$p[4]) }
      'K' { [CleftInput]::Key([uint16]$p[1], 0, [uint32]$p[2]) }
      'C' { [CleftInput]::Char([int]$p[1], $p[2] -eq '1', $p[3] -eq '1') }
    }
  } catch { }
}`;

/** One action as a line for the PowerShell loop. Coordinates go as 0..65535 on the primary screen. */
function windowsLine(a) {
  const ABS = 0x8000, MOVE = 0x1, WHEEL = 0x800, HWHEEL = 0x1000;
  const BTN = { left: [0x2, 0x4], right: [0x8, 0x10], middle: [0x20, 0x40] };
  if (a.t === 'move') return `M ${Math.round(a.x * 65535)} ${Math.round(a.y * 65535)} 0 ${ABS | MOVE}`;
  if (a.t === 'button') return `M 0 0 0 ${BTN[a.b][a.down ? 0 : 1]}`;
  if (a.t === 'wheel') return a.dy !== undefined ? `M 0 0 ${a.dy * 120} ${WHEEL}` : `M 0 0 ${a.dx * 120} ${HWHEEL}`;
  if (a.t === 'vk') return `K ${a.vk} ${(a.ext ? 1 : 0) | (a.down ? 0 : 2)}`;
  if (a.t === 'char') return `C ${a.code} ${a.down ? 1 : 0} ${a.viaKey ? 1 : 0}`;
  return null;
}

// ---------- elsewhere: xdotool (tests, development) ----------
const XKEY = { 0x08: 'BackSpace', 0x09: 'Tab', 0x0d: 'Return', 0x1b: 'Escape', 0x2e: 'Delete', 0x24: 'Home', 0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down', 0x21: 'Prior', 0x22: 'Next', 0x23: 'End', 0x2d: 'Insert', 0xa0: 'Shift_L', 0xa1: 'Shift_R', 0xa2: 'Control_L', 0xa3: 'Control_R', 0xa4: 'Alt_L', 0xa5: 'Alt_R', 0x5b: 'Super_L', 0x5c: 'Super_R' };
function xdotoolArgs(a, screenW, screenH) {
  if (a.t === 'move') return ['mousemove', String(Math.round(a.x * (screenW - 1))), String(Math.round(a.y * (screenH - 1)))];
  if (a.t === 'button') return [a.down ? 'mousedown' : 'mouseup', String({ left: 1, middle: 2, right: 3 }[a.b])];
  if (a.t === 'wheel') return ['click', String(a.dy > 0 ? 4 : a.dy < 0 ? 5 : a.dx < 0 ? 6 : 7)];
  if (a.t === 'vk') { const n = XKEY[a.vk] ?? (a.vk >= 0x70 && a.vk <= 0x7b ? `F${a.vk - 0x6f}` : null); return n ? [a.down ? 'keydown' : 'keyup', n] : null; }
  if (a.t === 'char') return [a.down ? 'keydown' : 'keyup', `0x${(a.code < 0x100 ? a.code : 0x01000000 + a.code).toString(16)}`];
  return null;
}

/**
 * The injector for this PC. `screenSize()` gives the primary screen in physical pixels (for xdotool).
 * Returns { apply(actions), close() }.
 */
function createInjector({ platform = process.platform, screenSize, onError } = {}) {
  if (platform === 'win32') {
    let child = null;
    const start = () => {
      const encoded = Buffer.from(PS_LOOP, 'utf16le').toString('base64');
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      child.on('error', (e) => { onError?.(e); child = null; });
      child.on('exit', () => { child = null; });
      child.stdin.on('error', () => { /* exit follows */ });
      // Read, or PowerShell stops once its error pipe fills (about 4 KB of errors) and input stalls.
      child.stderr.on('data', () => { /* dropped */ });
    };
    return {
      apply(actions) {
        if (!child) start();
        const lines = actions.map(windowsLine).filter(Boolean);
        if (lines.length && child?.stdin.writable) child.stdin.write(lines.join('\n') + '\n');
      },
      close() {
        const c = child;
        child = null;
        try { c?.stdin.end(); } catch { /* */ }
        if (c) setTimeout(() => { try { if (c.exitCode === null) c.kill(); } catch { /* */ } }, 1000);
      },
    };
  }
  // xdotool: one command per batch, in order.
  let chain = Promise.resolve();
  return {
    apply(actions) {
      const { width, height } = screenSize();
      const parts = actions.map((a) => xdotoolArgs(a, width, height)).filter(Boolean);
      if (!parts.length) return;
      chain = chain.then(() => new Promise((resolve) => {
        // xdotool chains commands on one line; each command takes its own arguments.
        const c = spawn('xdotool', parts.flat(), { stdio: 'ignore' });
        c.on('error', (e) => { onError?.(e); resolve(); });
        c.on('exit', resolve);
      }));
    },
    close() {},
  };
}

module.exports = { InputMapper, createInjector, windowsLine, xdotoolArgs, keysymChar, CSHARP, PS_LOOP };
