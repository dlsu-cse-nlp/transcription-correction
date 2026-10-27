import { $, pref } from "./util.js";
import { VimEngine } from "./vim-engine.js";

// Glue between the Vim engine and the #text textarea.
//   Normal / Visual: the block cursor is the textarea's own selection of one phoneme.
//   Insert: the browser types natively; we only track the caret (and record what was
//   typed so `.` can repeat it).

let eng = null;
let ta = null;
let enabled = false;
let prevMode = "normal";
let applying = false;
let wantX = null; // remembered column for consecutive j / k

const MODE_LABEL = { normal: "NORMAL", insert: "INSERT", visual: "VISUAL" };
const IGNORED = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "Dead", "Process", "Unidentified"]);
const SPECIAL = { Escape: "Esc", ArrowLeft: "h", ArrowRight: "l", ArrowUp: "k", ArrowDown: "j", Backspace: "h", Delete: "x", Home: "0", End: "$", " ": "l" };

// ---- visual-line movement for wrapped text (j / k) ---------------------------

// Lay every token out in an invisible copy of the textarea and read back where it landed.
function layoutTokens() {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const p of [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform",
    "wordSpacing", "textIndent", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "tabSize",
  ]) mirror.style[p] = cs[p];
  Object.assign(mirror.style, {
    position: "absolute", visibility: "hidden", left: "-99999px", top: "0",
    boxSizing: "border-box", border: "0", width: `${ta.clientWidth}px`,
    whiteSpace: "pre-wrap", overflowWrap: "break-word",
  });
  const spans = eng.toks.map((t) => {
    const s = document.createElement("span");
    s.textContent = t;
    mirror.append(s);
    return s;
  });
  document.body.append(mirror);
  const out = spans.map((s) => ({ top: s.offsetTop, left: s.offsetLeft }));
  mirror.remove();
  return out;
}

function vertical(index, dir) {
  const pos = layoutTokens();
  if (!pos.length) return null;
  const tops = [...new Set(pos.map((p) => Math.round(p.top / 4)))].sort((a, b) => a - b);
  const line = tops.indexOf(Math.round(pos[index].top / 4));
  const target = tops[line + dir];
  if (target === undefined) return null;
  if (wantX === null) wantX = pos[index].left;
  let best = null;
  pos.forEach((p, i) => {
    if (Math.round(p.top / 4) !== target) return;
    if (best === null || Math.abs(p.left - wantX) < Math.abs(pos[best].left - wantX)) best = i;
  });
  return best;
}

// ---- rendering ----------------------------------------------------------------

function paint() {
  const bar = $("#vimbar");
  if (!enabled) {
    delete ta.dataset.vim;
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  ta.dataset.vim = eng.mode;
  $("#vimmode").textContent = `-- ${MODE_LABEL[eng.mode]} --`;
  $("#vimpend").textContent = eng.pending;
  if (eng.mode === "insert") {
    if (prevMode !== "insert") {
      const o = eng.caretOffset();
      ta.setSelectionRange(o, o);
    }
  } else {
    const [a, b] = eng.selection();
    ta.setSelectionRange(a, b);
  }
  prevMode = eng.mode;
}

// Push engine text into the textarea (so the diff, etc. update through the normal input event).
function flushText() {
  if (ta.value === eng.text) return;
  applying = true;
  ta.value = eng.text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  applying = false;
}

// ---- events -------------------------------------------------------------------

function onKey(e) {
  if (!enabled || e.isComposing || IGNORED.has(e.key)) return;
  if (e.altKey || e.metaKey) return; // Alt+... are the app's own hotkeys

  let k = e.key;
  if (e.ctrlKey) {
    if (k === "[") k = "C-[";
    else if (k === "r" && eng.mode !== "insert") k = "C-r";
    else return; // leave Ctrl+C / V / Z / ... to the browser
  }

  if (eng.mode === "insert") {
    if (k === "Escape" || k === "C-[") {
      eng.syncFromDom(ta.value, ta.selectionStart);
      eng.key("Esc");
      e.preventDefault();
      e.stopPropagation(); // don't also clear the waveform selection
      wantX = null;
      flushText();
      paint();
    } else if (k === "Backspace") eng.recordBackspace();
    else if (k.length === 1 && !e.ctrlKey) eng.recordTyped(k);
    return;
  }

  // Normal / Visual
  if (k === "Enter" && !e.shiftKey) return; // Enter = save and next, as always
  if (k === "Tab" || /^F\d+$/.test(k)) return;

  const name = SPECIAL[k] ?? k;
  e.preventDefault();
  if (name.length !== 1 && !["Esc", "C-r", "C-["].includes(name)) return; // swallow PageUp, Shift+Enter, ...

  const before = { mode: eng.mode, pending: eng.buf.length };
  if (name !== "j" && name !== "k") wantX = null;
  eng.key(name === "C-[" ? "Esc" : name);
  if (name === "Esc" && (before.mode !== "normal" || before.pending)) e.stopPropagation();
  flushText();
  paint();
}

function onInput() {
  if (!enabled || applying) return;
  if (eng.mode === "insert") eng.syncFromDom(ta.value, ta.selectionStart);
  else {
    eng.setText(ta.value); // e.g. pasted with Ctrl+V while in normal mode
    paint();
  }
}

function onMouseUp() {
  if (!enabled || eng.mode !== "normal") return;
  eng.setCursorFromOffset(ta.selectionStart);
  wantX = null;
  paint();
}

// ---- public API ---------------------------------------------------------------

// Call whenever the textbox content is replaced (new sample, Back/Forward, Reset).
export function vimReset() {
  if (!ta) return;
  if (!enabled) return paint();
  eng.reset(ta.value);
  prevMode = "normal";
  wantX = null;
  paint();
}

export function initVim({ translate, onSave }) {
  ta = $("#text");
  eng = new VimEngine({
    translate,
    onSave,
    vertical,
    onYank: (t) => navigator.clipboard?.writeText(t).catch(() => {}),
  });

  const box = $("#vim");
  enabled = pref.get("vim", false);
  box.checked = enabled;
  box.addEventListener("change", () => {
    enabled = box.checked;
    pref.set("vim", enabled);
    if (!enabled) {
      const o = ta.selectionEnd;
      ta.setSelectionRange(o, o);
    }
    vimReset();
    ta.focus();
  });

  ta.addEventListener("keydown", onKey);
  ta.addEventListener("input", onInput);
  ta.addEventListener("mouseup", onMouseUp);
  // palette buttons: switch to insert mode at the cursor before inserting a symbol
  ta.addEventListener("vim:prepare-insert", () => {
    if (!enabled || eng.mode === "insert") return;
    eng.startInsertAtCursor();
    paint();
  });

  vimReset();
}
