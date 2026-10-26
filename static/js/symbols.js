import { $, pref } from "./util.js";

// ---- Edit these to match your annotation conventions ---------------------

// Typing the key on the left inserts the symbol on the right (only while
// "Typing shortcuts" is ticked). Keys are chosen so they never occur in the
// phoneme set themselves: your table has no ASCII g (it uses ɡ U+0261), no r
// (tap is ɾ), and no uppercase letters or punctuation.
export const SHORTCUTS = {
  "?": "ʔ",
  g: "ɡ",
  r: "ɾ",
  N: "ŋ",
  S: "ʃ",
  Z: "ʒ",
  "@": "ə"
};

// Buttons shown under the textbox. Only symbols that are awkward to type.
export const PALETTE = ["ʔ", "ŋ", "ɾ", "ɡ", "ʃ", "ʒ", "ə", "t͡s", "d͡z", "t͡ʃ", "d͡ʒ"];

// ---------------------------------------------------------------------------

const keyFor = Object.fromEntries(Object.entries(SHORTCUTS).map(([k, v]) => [v, k]));

// Insert at the caret via execCommand so the browser's undo (Ctrl+Z) still works.
export function insertAtCursor(textarea, str) {
  textarea.focus();
  if (document.execCommand?.("insertText", false, str)) return;
  const { selectionStart: a, selectionEnd: b } = textarea;
  textarea.setRangeText(str, a, b, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export function initSymbols() {
  const textarea = $("#text");
  const toggle = $("#shortcuts");
  toggle.checked = pref.get("shortcuts", true);
  toggle.addEventListener("change", () => {
    pref.set("shortcuts", toggle.checked);
    textarea.focus();
  });

  $("#palette").replaceChildren(
    ...PALETTE.map((sym) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sym";
      const glyph = document.createElement("span");
      glyph.textContent = sym;
      b.append(glyph);
      if (keyFor[sym]) {
        const k = document.createElement("small");
        k.textContent = keyFor[sym];
        b.append(k);
        b.title = `Insert ${sym} (or type ${keyFor[sym]})`;
      } else {
        b.title = `Insert ${sym}`;
      }
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep caret in textbox
      b.addEventListener("click", () => insertAtCursor(textarea, sym));
      return b;
    }),
  );

  textarea.addEventListener("keydown", (e) => {
    if (!toggle.checked || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    const sym = SHORTCUTS[e.key];
    if (!sym) return;
    e.preventDefault();
    insertAtCursor(textarea, sym);
  });
}
