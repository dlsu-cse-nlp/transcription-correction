import { $, api, setError, pref } from "./util.js";
import { ensure, retainOnly, audioUrl } from "./audio-cache.js";
import {
  initWaveform, showWaveform, clearWaveform, applySpeed, stepSpeed,
  togglePlay, replay, restart, toggleLoop, hasSelection, clearSelection,
} from "./waveform.js";
import { initSymbols, translateKey } from "./symbols.js";
import { initVim, vimReset } from "./vim.js";
import { renderDiff } from "./diff.js";

const PRELOAD_AHEAD = 2;
const s = { queue: [], pos: 0, maxPos: 0, total: 0, alreadyDone: 0, outName: "", busy: false, loadSeq: 0 };
const original = (item) => item.entry.text ?? "";
// What the textbox should show for an item: unsaved draft > last saved text > original.
const initialText = (item) => item.draft ?? item.saved ?? original(item);

export function startReview({ queue, total, alreadyDone, outName, meta }) {
  Object.assign(s, { queue, total, alreadyDone, outName, pos: 0, maxPos: 0 });
  $("#meta").textContent = meta;
  $("#guide").open = false; // reclaim vertical space once the work starts
  render();
}

// Keep unsaved edits when navigating away (Back / Forward).
function stashDraft() {
  const item = s.queue[s.pos];
  if (!item) return;
  const v = $("#text").value;
  if (v !== (item.saved ?? original(item))) item.draft = v;
  else delete item.draft;
}

function loadAudio(item) {
  const audio = $("#au");
  const seq = ++s.loadSeq;

  // Free anything outside the window we might still need; start fetching upcoming items.
  const keep = new Set();
  for (let i = s.pos - 1; i <= s.pos + PRELOAD_AHEAD; i++) {
    const it = s.queue[i];
    if (it?.audio_ok) {
      keep.add(it.key);
      ensure(it.key, it.entry.audio_filepath);
    }
  }
  retainOnly(keep);

  if (!item.audio_ok) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    clearWaveform("No audio");
    setError($("#noaudio"), "Audio file not found under the server root. You can still edit and save the text.");
    return;
  }

  setError($("#noaudio"), "");
  const cached = ensure(item.key, item.entry.audio_filepath);
  audio.src = cached.url ?? audioUrl(item.entry.audio_filepath); // blob URL if preloaded, else stream
  applySpeed(); // changing src resets playbackRate in some browsers
  if ($("#autoplay").checked) audio.play().catch(() => {});

  clearWaveform("Loading waveform…");
  cached.buffer
    .then((buf) => { if (seq === s.loadSeq) showWaveform(buf); })
    .catch(() => { if (seq === s.loadSeq) clearWaveform("Couldn't draw waveform (audio still plays)"); });
}

function render() {
  const finished = s.pos >= s.queue.length;
  const audio = $("#au");
  $("#review").classList.toggle("hidden", finished);
  $("#done").classList.toggle("hidden", !finished);
  $("#prog").max = s.total;
  $("#prog").value = Math.min(s.alreadyDone + s.pos, s.total);

  if (finished) {
    audio.pause();
    $("#done-text").textContent = `${s.alreadyDone + s.queue.length} of ${s.total} entries are in ${s.outName}.`;
    $("#done-back").disabled = s.queue.length === 0;
    return;
  }

  s.maxPos = Math.max(s.maxPos, s.pos);
  const item = s.queue[s.pos];
  $("#count").textContent = `${s.alreadyDone + s.pos + 1} of ${s.total}`;
  $("#path").textContent = item.entry.audio_filepath;
  $("#back").disabled = s.pos === 0;
  $("#fwd").disabled = s.pos >= s.maxPos;
  setError($("#msg"), "");

  $("#text").value = initialText(item);
  updateEdited();
  loadAudio(item);
  $("#text").focus();
  vimReset();
}

function updateEdited() {
  const item = s.queue[s.pos];
  const orig = original(item);
  const value = $("#text").value;
  const changed = value !== orig;
  for (const id of ["#edited", "#reset", "#diff-row"]) $(id).classList.toggle("hidden", !changed);
  if (changed) {
    const hunks = renderDiff($("#diff"), orig, value);
    $("#edited").textContent = `Edited · ${hunks} change${hunks === 1 ? "" : "s"}`;
  } else {
    $("#diff").replaceChildren();
  }
}

async function save() {
  if (s.busy || s.pos >= s.queue.length) return;
  s.busy = true;
  $("#save").disabled = true;
  const item = s.queue[s.pos];
  const orig = original(item);
  const value = $("#text").value;
  const text = value === orig ? orig : value.replace(/[\r\n]+/g, " ").trim();
  try {
    await api("/api/save", { key: item.key, text });
    item.saved = text;
    delete item.draft;
    s.pos++;
    render();
  } catch (e) {
    setError($("#msg"), `Not saved: ${e.message}`);
  } finally {
    s.busy = false;
    $("#save").disabled = false;
  }
}

function back() {
  if (s.pos > 0) { stashDraft(); s.pos--; render(); }
}

// Only to items already visited this session (so nothing is skipped without being saved).
function forward() {
  if (s.pos < s.maxPos && s.pos + 1 < s.queue.length) { stashDraft(); s.pos++; render(); }
}

const HOTKEYS = {
  KeyP: () => togglePlay(),
  KeyR: (e) => (e.shiftKey ? restart() : replay(2)),
  KeyL: () => toggleLoop(),
  ArrowUp: () => stepSpeed(+1),
  ArrowDown: () => stepSpeed(-1),
  ArrowLeft: () => back(),
  ArrowRight: () => forward(),
};

export function initReview() {
  const textarea = $("#text");

  initWaveform();
  initSymbols();
  initVim({ translate: translateKey, onSave: save });

  textarea.addEventListener("input", updateEdited);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && !e.shiftKey) { e.preventDefault(); save(); }
  });

  document.addEventListener("keydown", (e) => {
    if ($("#review").classList.contains("hidden")) return;
    if (e.key === "Escape" && hasSelection()) { clearSelection(); return; }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const act = HOTKEYS[e.code]; // e.code: works on macOS where Option+letter changes e.key
    if (act) { e.preventDefault(); act(e); }
  });

  $("#autoplay").checked = pref.get("autoplay", true);
  $("#autoplay").addEventListener("change", (e) => { pref.set("autoplay", e.target.checked); textarea.focus(); });

  $("#save").addEventListener("click", save);
  $("#back").addEventListener("click", back);
  $("#fwd").addEventListener("click", forward);
  $("#reset").addEventListener("click", () => {
    textarea.value = original(s.queue[s.pos]);
    updateEdited();
    textarea.focus();
    vimReset();
  });
  $("#done-back").addEventListener("click", () => { s.pos = s.queue.length - 1; render(); });
}
