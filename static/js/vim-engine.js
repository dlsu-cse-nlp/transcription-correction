// A small, DOM-free Vim emulation for a single line of phoneme text.
//
// The buffer is an array of phoneme tokens (see diff.js: t͡ʃ, aː, ... are one
// token each), and the cursor is a token index. So `x`, `l`, `r`, `dw` ... all
// operate on whole phonemes and never split a tie bar from its letters.
//
// Supported
//   motions   h l 0 ^ $ w W b B e E f F t T ; , j k   (counts: 3w, 2fa)
//   operators d c y + motion / text object / doubled (dd cc yy), e.g. dw c$ yiw d2f'
//   objects   iw aw iW aW
//   commands  i a I A  x X D C s S Y  r{c}  p P  ~  u  Ctrl-R  .  v  ZZ
//   visual    v, then motions, d x c s y ~ p o iw aw
// Not supported (deliberately): registers, marks, macros, search, R, o/O (single line).

import { tokenize } from "./diff.js";

const KEYWORD = /^[\p{L}\p{M}\p{N}_]/u;
const isSpace = (t) => /^\s/.test(t);
// 0 = blank, 1 = punctuation (or any non-blank for WORD motions), 2 = word character
const cls = (t, big = false) => (t === undefined || isSpace(t) ? 0 : big ? 1 : KEYWORD.test(t) ? 2 : 1);

const OP_KEYS = new Set(["d", "c", "y"]);
const MOTION_KEYS = new Set(["h", "l", "0", "^", "$", "w", "W", "b", "B", "e", "E", ";", ",", "j", "k"]);
const FIND_KEYS = new Set(["f", "F", "t", "T"]);
const INCOMPLETE = { status: "incomplete" };
const INVALID = { status: "invalid" };
const done = (cmd) => ({ status: "complete", cmd });

// ---- key sequence parser ----------------------------------------------------

function parse(buf, visual) {
  let i = 0;
  const readCount = () => {
    if (i < buf.length && /^[1-9]$/.test(buf[i])) {
      let s = "";
      while (i < buf.length && /^[0-9]$/.test(buf[i])) s += buf[i++];
      return Number(s);
    }
    return null;
  };
  const motionAt = (t, forOp) => {
    if (FIND_KEYS.has(t)) {
      if (i >= buf.length) return INCOMPLETE;
      return { status: "complete", motion: { k: t, ch: buf[i++] } };
    }
    if (MOTION_KEYS.has(t) && !(forOp && (t === "j" || t === "k"))) {
      return { status: "complete", motion: { k: t } };
    }
    return INVALID;
  };

  const c1 = readCount();
  if (i >= buf.length) return INCOMPLETE;
  const k = buf[i++];

  if (visual) {
    if (k === "i" || k === "a") {
      if (i >= buf.length) return INCOMPLETE;
      return done({ kind: "vobj", obj: k + buf[i++] });
    }
    if ("dxcsy~po".includes(k) && k.length === 1) return done({ kind: "vop", name: k });
    if (k === "v") return done({ kind: "vexit" });
    const m = motionAt(k, false);
    if (m.status !== "complete") return m;
    return done({ kind: "motion", motion: m.motion, count: c1 ?? 1 });
  }

  if (OP_KEYS.has(k)) {
    const c2 = readCount();
    if (i >= buf.length) return INCOMPLETE;
    const t = buf[i++];
    const count = (c1 ?? 1) * (c2 ?? 1);
    if (t === k) return done({ kind: "op", op: k, line: true, count });
    if (t === "i" || t === "a") {
      if (i >= buf.length) return INCOMPLETE;
      return done({ kind: "op", op: k, obj: t + buf[i++], count });
    }
    const m = motionAt(t, true);
    if (m.status !== "complete") return m;
    return done({ kind: "op", op: k, motion: m.motion, count });
  }

  if (k === "r") {
    if (i >= buf.length) return INCOMPLETE;
    return done({ kind: "simple", name: "r", ch: buf[i++], count: c1 ?? 1 });
  }
  if (k === "Z") {
    if (i >= buf.length) return INCOMPLETE;
    return buf[i] === "Z" ? done({ kind: "simple", name: "ZZ", count: 1 }) : INVALID;
  }
  if ("xXDCsSYpPu.~iaIAv".includes(k) && k.length === 1) return done({ kind: "simple", name: k, count: c1 ?? 1 });
  if (k === "C-r") return done({ kind: "simple", name: "C-r", count: c1 ?? 1 });

  const m = motionAt(k, false);
  if (m.status !== "complete") return m;
  return done({ kind: "motion", motion: m.motion, count: c1 ?? 1 });
}

// ---- engine ----------------------------------------------------------------

export class VimEngine {
  constructor({ translate = (k) => k, vertical = null, onYank = null, onSave = null } = {}) {
    this.translate = translate; // maps a typed key to the symbol it stands for (e.g. ? -> ʔ)
    this.vertical = vertical; // (tokenIndex, dir) -> tokenIndex | null  (visual-line movement)
    this.onYank = onYank;
    this.onSave = onSave;
    this.reset("");
  }

  reset(text) {
    this.toks = tokenize(text);
    this.cur = 0;
    this.anchor = 0;
    this.mode = "normal";
    this.buf = [];
    this.undoStack = [];
    this.redoStack = [];
    this.reg = [];
    this.insert = null;
    this.lastFind = null;
    this.lastChange = null;
    this.currentChange = null;
    this.replaying = null;
  }

  // ---- state helpers ----
  get text() { return this.toks.join(""); }
  get pending() { return this.buf.join(""); }
  get len() { return this.toks.length; }

  clamp() { this.cur = Math.min(Math.max(this.cur, 0), Math.max(0, this.len - 1)); }
  offsetOf(i) { let n = 0; for (let j = 0; j < i && j < this.len; j++) n += this.toks[j].length; return n; }

  // token containing a code-unit offset (for mouse clicks)
  indexAtOffset(off) {
    let acc = 0;
    for (let i = 0; i < this.len; i++) {
      acc += this.toks[i].length;
      if (off < acc) return i;
    }
    return Math.max(0, this.len - 1);
  }

  // insertion point (number of tokens fully before the caret)
  insertionIndex(off) {
    let acc = 0;
    let i = 0;
    while (i < this.len && acc + this.toks[i].length <= off) acc += this.toks[i++].length;
    return i;
  }

  // [start, end) code-unit range the adapter should show as selected (block cursor / visual)
  selection() {
    if (this.len === 0) return [0, 0];
    if (this.mode === "visual") {
      const lo = Math.min(this.anchor, this.cur);
      const hi = Math.max(this.anchor, this.cur);
      return [this.offsetOf(lo), this.offsetOf(hi + 1)];
    }
    return [this.offsetOf(this.cur), this.offsetOf(this.cur + 1)];
  }

  caretOffset() { return this.insert ? this.offsetOf(this.insert.pos) : this.offsetOf(this.cur); }

  setCursorFromOffset(off) { this.cur = this.indexAtOffset(off); }

  // External change of the text while in normal/visual mode (paste, reset button...)
  setText(text) { this.toks = tokenize(text); this.clamp(); this.anchor = Math.min(this.anchor, Math.max(0, this.len - 1)); }

  // Insert mode: the browser edits the textarea natively; keep our model in step.
  syncFromDom(text, caretOffset) {
    this.toks = tokenize(text);
    if (this.insert) this.insert.pos = this.insertionIndex(caretOffset);
  }

  snapshot() { return { toks: this.toks.slice(), cur: this.cur }; }
  restore(s) { this.toks = s.toks.slice(); this.cur = s.cur; this.clamp(); }
  pushUndo(s = this.snapshot()) { this.undoStack.push(s); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack = []; }

  // run `fn` as one undoable change; drop the undo entry if nothing changed
  change(fn) {
    const before = this.snapshot();
    this.pushUndo(before);
    fn();
    if (!this.insert && before.toks.join("") === this.text) this.undoStack.pop();
  }

  // ---- key entry ----
  key(k) {
    if (this.mode === "insert") {
      if (k === "Esc" || k === "C-[") { this.exitInsert(); return true; }
      return false; // let the browser type it
    }
    if (k === "Esc" || k === "C-[") {
      this.buf = [];
      if (this.mode === "visual") { this.mode = "normal"; this.clamp(); }
      return true;
    }
    this.buf.push(k);
    const r = parse(this.buf, this.mode === "visual");
    if (r.status === "incomplete") return true;
    const keys = this.buf;
    this.buf = [];
    if (r.status === "complete") this.exec(r.cmd, keys);
    return true;
  }

  // insert-mode bookkeeping for dot-repeat (called by the adapter on keydown)
  recordTyped(k) { if (this.insert) this.insert.text += this.translate(k); }
  recordBackspace() {
    if (!this.insert || !this.insert.text) return;
    const t = tokenize(this.insert.text);
    t.pop();
    this.insert.text = t.join("");
  }

  // test helper: behave like typing text in insert mode
  typeText(s) {
    if (!this.insert) return;
    const add = tokenize(s);
    this.toks.splice(this.insert.pos, 0, ...add);
    this.insert.pos += add.length;
    this.insert.text += s;
  }

  // ---- insert mode ----
  startInsert(pos, count = 1) {
    this.mode = "insert";
    this.insert = { pos, text: "", count, record: this.currentChange };
    if (this.replaying) {
      const t = this.replaying.insert ?? "";
      this.insert.text = t;
      this.applyText(t, 1);
      this.exitInsert();
    }
  }

  applyText(text, times) {
    const add = tokenize(text);
    for (let n = 0; n < times; n++) {
      this.toks.splice(this.insert.pos, 0, ...add);
      this.insert.pos += add.length;
    }
  }

  exitInsert() {
    const st = this.insert;
    if (!st) return;
    if (st.record && !this.replaying) st.record.insert = st.text;
    if (st.count > 1 && st.text) this.applyText(st.text, st.count - 1);
    this.mode = "normal";
    this.insert = null;
    this.cur = st.pos - 1;
    this.clamp();
  }

  startInsertAtCursor() {
    if (this.mode === "insert") return;
    this.mode = "normal";
    this.buf = [];
    this.currentChange = null;
    this.pushUndo();
    this.startInsert(Math.min(this.cur, this.len), 1);
  }

  // ---- motions ----
  nextWord(i, big) {
    let j = i;
    if (j >= this.len) return this.len;
    const c = cls(this.toks[j], big);
    if (c !== 0) while (j < this.len && cls(this.toks[j], big) === c) j++;
    while (j < this.len && cls(this.toks[j], big) === 0) j++;
    return j;
  }
  prevWord(i, big) {
    let j = i - 1;
    if (j < 0) return 0;
    while (j > 0 && cls(this.toks[j], big) === 0) j--;
    const c = cls(this.toks[j], big);
    while (j > 0 && cls(this.toks[j - 1], big) === c) j--;
    return j;
  }
  endWord(i, big) {
    let j = i + 1;
    while (j < this.len && cls(this.toks[j], big) === 0) j++;
    if (j >= this.len) return Math.max(0, this.len - 1);
    const c = cls(this.toks[j], big);
    while (j + 1 < this.len && cls(this.toks[j + 1], big) === c) j++;
    return j;
  }

  find(k, ch, i, n, repeating) {
    const fwd = k === "f" || k === "t";
    const till = k === "t" || k === "T";
    let j = i + (fwd ? 1 : -1) + (repeating && till ? (fwd ? 1 : -1) : 0);
    const want = this.translate(ch);
    let found = -1;
    for (; j >= 0 && j < this.len; j += fwd ? 1 : -1) {
      if (this.toks[j].startsWith(want) && --n === 0) { found = j; break; }
    }
    return found;
  }

  // returns { t, incl } or null if the motion fails
  motionTarget(m, i, n, forOp) {
    const len = this.len;
    const last = Math.max(0, len - 1);
    switch (m.k) {
      case "h": return { t: Math.max(0, i - n), incl: false };
      case "l": return { t: forOp ? Math.min(len, i + n) : Math.min(last, i + n), incl: false };
      case "0": return { t: 0, incl: false };
      case "^": { let j = 0; while (j < last && cls(this.toks[j]) === 0) j++; return { t: j, incl: false }; }
      case "$": return { t: last, incl: true };
      case "w": case "W": {
        let t = i;
        for (let x = 0; x < n; x++) t = this.nextWord(t, m.k === "W");
        return { t: forOp ? t : Math.min(last, t), incl: false };
      }
      case "b": case "B": {
        let t = i;
        for (let x = 0; x < n; x++) t = this.prevWord(t, m.k === "B");
        return { t, incl: false };
      }
      case "e": case "E": {
        let t = i;
        for (let x = 0; x < n; x++) t = this.endWord(t, m.k === "E");
        return { t, incl: true };
      }
      case "f": case "F": case "t": case "T": {
        const found = this.find(m.k, m.ch, i, n, false);
        if (found < 0) return null;
        this.lastFind = { k: m.k, ch: m.ch };
        if (m.k === "f") return { t: found, incl: true };
        if (m.k === "F") return { t: found, incl: false };
        if (m.k === "t") return { t: found - 1, incl: true };
        return { t: found + 1, incl: false };
      }
      case ";": case ",": {
        if (!this.lastFind) return null;
        const flip = { f: "F", F: "f", t: "T", T: "t" };
        const k = m.k === ";" ? this.lastFind.k : flip[this.lastFind.k];
        const found = this.find(k, this.lastFind.ch, i, n, true);
        if (found < 0) return null;
        if (k === "f") return { t: found, incl: true };
        if (k === "F") return { t: found, incl: false };
        if (k === "t") return { t: found - 1, incl: true };
        return { t: found + 1, incl: false };
      }
      case "j": case "k": {
        if (!this.vertical) return null;
        let t = i;
        for (let x = 0; x < n; x++) {
          const next = this.vertical(t, m.k === "j" ? 1 : -1);
          if (next == null || next === t) break;
          t = next;
        }
        return { t, incl: false };
      }
      default: return null;
    }
  }

  // `cw` on a word behaves like `ce` but never jumps to the next word
  cwTarget(i, n, big) {
    let t = i;
    const c = cls(this.toks[i], big);
    while (t + 1 < this.len && cls(this.toks[t + 1], big) === c) t++;
    for (let x = 1; x < n; x++) t = this.endWord(t, big);
    return t;
  }

  objectRange(kind) {
    const len = this.len;
    if (!len || !/^[ia][wW]$/.test(kind)) return null;
    const big = kind[1] === "W";
    const c = cls(this.toks[this.cur], big);
    let lo = this.cur;
    let hi = this.cur + 1;
    while (lo > 0 && cls(this.toks[lo - 1], big) === c) lo--;
    while (hi < len && cls(this.toks[hi], big) === c) hi++;
    if (kind[0] === "a") {
      if (c !== 0) {
        let h = hi;
        while (h < len && cls(this.toks[h], big) === 0) h++;
        if (h > hi) hi = h;
        else { let l = lo; while (l > 0 && cls(this.toks[l - 1], big) === 0) l--; lo = l; }
      } else if (hi < len) {
        const c2 = cls(this.toks[hi], big);
        while (hi < len && cls(this.toks[hi], big) === c2) hi++;
      }
    }
    return [lo, hi];
  }

  // ---- execution ----
  applyOp(op, lo, hi) {
    lo = Math.max(0, lo);
    hi = Math.min(this.len, hi);
    if (op === "y") {
      if (hi > lo) this.yank(this.toks.slice(lo, hi));
      this.cur = lo;
      this.clamp();
      return;
    }
    if (hi > lo) {
      this.yank(this.toks.slice(lo, hi));
      this.toks.splice(lo, hi - lo);
    }
    if (op === "c") { this.cur = lo; this.startInsert(lo, this.pendingCount || 1); }
    else { this.cur = lo; this.clamp(); }
  }

  yank(tokens) {
    this.reg = tokens;
    this.onYank?.(tokens.join(""));
  }

  rangeFromMotion(r, i) {
    let lo;
    let hi;
    if (r.t >= i) { lo = i; hi = r.incl ? r.t + 1 : r.t; }
    else { lo = r.t; hi = r.incl ? i + 1 : i; }
    return [lo, Math.min(hi, this.len)];
  }

  exec(cmd, keys) {
    const mutating = cmd.kind === "op" ? cmd.op !== "y" : cmd.kind === "simple" && "xXDCsSrpP~iaIA".includes(cmd.name[0]) && cmd.name !== "C-r";
    this.pendingCount = 1;
    this.currentChange = null;
    if (mutating && !this.replaying) {
      this.currentChange = { keys: keys.slice(), insert: null };
      this.lastChange = this.currentChange;
    }

    switch (cmd.kind) {
      case "motion": return this.doMotion(cmd.motion, cmd.count);
      case "op": return this.doOperator(cmd);
      case "simple": return this.doSimple(cmd);
      case "vobj": {
        const r = this.objectRange(cmd.obj);
        if (r) { this.anchor = r[0]; this.cur = r[1] - 1; }
        return;
      }
      case "vexit": this.mode = "normal"; this.clamp(); return;
      case "vop": return this.doVisualOp(cmd.name);
    }
  }

  doMotion(m, n) {
    const r = this.motionTarget(m, this.cur, n, false);
    if (r) { this.cur = r.t; this.clamp(); }
  }

  doOperator(cmd) {
    const { op, count } = cmd;
    this.pendingCount = 1;
    const run = () => {
      if (cmd.line) return this.applyOp(op, 0, this.len);
      if (cmd.obj) {
        const r = this.objectRange(cmd.obj);
        if (r) this.applyOp(op, r[0], r[1]);
        return;
      }
      const m = cmd.motion;
      let r;
      if (op === "c" && (m.k === "w" || m.k === "W") && cls(this.toks[this.cur], m.k === "W") !== 0) {
        r = { t: this.cwTarget(this.cur, count, m.k === "W"), incl: true };
      } else {
        r = this.motionTarget(m, this.cur, count, true);
      }
      if (!r) return;
      const [lo, hi] = this.rangeFromMotion(r, this.cur);
      this.applyOp(op, lo, hi);
    };
    if (op === "y") run();
    else this.change(run);
  }

  doSimple({ name, ch, count }) {
    const n = count;
    const cur = this.cur;
    switch (name) {
      case "i": return this.change(() => this.startInsert(cur, n));
      case "a": return this.change(() => this.startInsert(Math.min(this.len, cur + (this.len ? 1 : 0)), n));
      case "I": return this.change(() => { let j = 0; while (j < this.len && cls(this.toks[j]) === 0) j++; this.startInsert(j, n); });
      case "A": return this.change(() => this.startInsert(this.len, n));
      case "x": return this.change(() => this.applyOp("d", cur, cur + n));
      case "X": return this.change(() => { this.applyOp("d", cur - n, cur); });
      case "D": return this.change(() => this.applyOp("d", cur, this.len));
      case "C": return this.change(() => this.applyOp("c", cur, this.len));
      case "s": return this.change(() => { this.pendingCount = 1; this.applyOp("c", cur, cur + n); });
      case "S": return this.change(() => this.applyOp("c", 0, this.len));
      case "Y": return this.applyOp("y", 0, this.len);
      case "r": {
        if (!this.len || cur + n > this.len) return;
        const sym = this.translate(ch);
        if (sym.length === 0) return;
        return this.change(() => {
          for (let j = cur; j < cur + n; j++) this.toks[j] = sym;
          this.cur = cur + n - 1;
        });
      }
      case "p": case "P": {
        if (!this.reg.length) return;
        return this.change(() => {
          const at = name === "p" ? Math.min(this.len, cur + (this.len ? 1 : 0)) : cur;
          const add = [];
          for (let x = 0; x < n; x++) add.push(...this.reg);
          this.toks.splice(at, 0, ...add);
          this.cur = at + add.length - 1;
        });
      }
      case "~": {
        if (!this.len) return;
        return this.change(() => {
          const end = Math.min(this.len, cur + n);
          for (let j = cur; j < end; j++) {
            const t = this.toks[j];
            this.toks[j] = t === t.toUpperCase() ? t.toLowerCase() : t.toUpperCase();
          }
          this.cur = Math.min(this.len - 1, end);
        });
      }
      case "u": for (let x = 0; x < n; x++) this.undo(); return;
      case "C-r": for (let x = 0; x < n; x++) this.redo(); return;
      case ".": return this.dot(n);
      case "v": if (this.len) { this.mode = "visual"; this.anchor = this.cur; } return;
      case "ZZ": this.onSave?.(); return;
    }
  }

  doVisualOp(name) {
    const lo = Math.min(this.anchor, this.cur);
    const hi = Math.max(this.anchor, this.cur) + 1;
    if (name === "o") { [this.anchor, this.cur] = [this.cur, this.anchor]; return; }
    this.mode = "normal";
    if (name === "y") return this.applyOp("y", lo, hi);
    if (name === "d" || name === "x") return this.change(() => this.applyOp("d", lo, hi));
    if (name === "c" || name === "s") return this.change(() => this.applyOp("c", lo, hi));
    if (name === "~") {
      return this.change(() => {
        for (let j = lo; j < hi; j++) {
          const t = this.toks[j];
          this.toks[j] = t === t.toUpperCase() ? t.toLowerCase() : t.toUpperCase();
        }
        this.cur = lo;
      });
    }
    if (name === "p") {
      if (!this.reg.length) return;
      const reg = this.reg.slice();
      return this.change(() => {
        this.toks.splice(lo, hi - lo, ...reg);
        this.cur = lo + reg.length - 1;
      });
    }
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  dot(times) {
    const lc = this.lastChange;
    if (!lc) return;
    for (let x = 0; x < times; x++) {
      this.replaying = { insert: lc.insert };
      try {
        for (const k of lc.keys) {
          this.buf.push(k);
          const r = parse(this.buf, false);
          if (r.status === "incomplete") continue;
          const keys = this.buf;
          this.buf = [];
          if (r.status === "complete") this.exec(r.cmd, keys);
        }
      } finally {
        this.replaying = null;
        this.buf = [];
      }
    }
    this.lastChange = lc;
  }
}
