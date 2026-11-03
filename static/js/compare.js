// Compare two manifests: count conflicts, write the agreed entries, then resolve the rest.
import { $, api, setError, pref } from "./util.js";
import { ensure, retainOnly, audioUrl } from "./audio-cache.js";
import {
  initWaveform, showWaveform, clearWaveform, applySpeed, stepSpeed,
  togglePlay, replay, restart, toggleLoop, hasSelection, clearSelection,
} from "./waveform.js";
import { initSymbols, translateKey } from "./symbols.js";
import { initVim, vimReset } from "./vim.js";
import { diffTokens, tokenize } from "./diff.js";

const PRELOAD_AHEAD = 2;
const s = { queue: [], pos: 0, maxPos: 0, total: 0, alreadyDone: 0, outName: "", busy: false, loadSeq: 0, analysis: null };
const show = (id, on) => $(id).classList.toggle("hidden", !on);
const clean = (v) => v.replace(/[\r\n]+/g, " ").trim();
const stem = (name, fallback) => (name ? name.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") : fallback);
const LABEL = { a: "A", b: "B", manual: "your edit", expert: "raised to expert" };

// ---------------------------------------------------------------- setup

let nameTouched = false;
let labels = { a: "A", b: "B" };

async function sideRequest(side) {
  const file = $(`#${side}file`).files[0];
  const path = $(`#${side}path`).value.trim();
  if (file) return { [`${side}_text`]: await file.text(), name: file.name };
  if (!path) throw new Error(`Choose file ${side.toUpperCase()}.`);
  return { [`${side}_path`]: path, name: path };
}

async function analyze() {
  const err = $("#setup-err");
  setError(err, "");
  const mode = document.querySelector("input[name=mode]:checked").value;
  const outPath = $(mode === "resume" ? "#rpath" : "#npath").value.trim();
  try {
    const [a, b] = [await sideRequest("a"), await sideRequest("b")];
    if (!outPath) throw new Error(mode === "resume" ? "Choose the output file to resume." : "Enter a name for the new output file.");
    const { name: an, ...aReq } = a;
    const { name: bn, ...bReq } = b;
    labels = { a: stem(an, "A"), b: stem(bn, "B") };
    if (labels.a === labels.b) labels = { a: `${labels.a} (A)`, b: `${labels.b} (B)` };
    $("#analyze").disabled = true;
    const r = await api("/api/compare/load", {
      ...aReq, ...bReq, mode, out_path: outPath, include_unpaired: $("#unpaired").checked,
    });
    s.analysis = r;
    renderSummary(r);
    if (r.conflicts_left === 0) await commit(); // nothing to decide: write straight away
  } catch (e) {
    setError(err, e.message);
  } finally {
    $("#analyze").disabled = false;
  }
}

function renderSummary(r) {
  show("#setup", false);
  show("#summary", true);
  setError($("#sum-err"), "");
  const rows = [
    [`Entries in ${labels.a}`, r.total_a],
    [`Entries in ${labels.b}`, r.total_b],
    ["Matched on audio_filepath", r.matched],
    ["Identical text (no conflict)", r.agreed, "sub"],
    ["Conflicting text", r.conflicts, "hl"],
  ];
  if (r.conflicts !== r.conflicts_left) rows.push(["Conflicts still to resolve", r.conflicts_left, "sub"]);
  rows.push(
    [`Only in ${labels.a}`, r.only_a],
    [`Only in ${labels.b}`, r.only_b],
  );
  if (r.duplicates) rows.push(["Duplicate audio_filepath (ignored)", r.duplicates]);
  if (r.invalid) rows.push(["Rows without audio_filepath (skipped)", r.invalid]);
  if (r.already_done) rows.push(["Already in the output (skipped)", r.already_done]);
  $("#stats").replaceChildren(
    ...rows.map(([label, n, cls]) => {
      const tr = document.createElement("tr");
      if (cls) tr.className = cls;
      for (const t of [label, n]) tr.append(Object.assign(document.createElement("td"), { textContent: t }));
      return tr;
    }),
  );
  const unp = r.include_unpaired ? r.only_a + r.only_b : 0;
  const toWrite = r.agreed + unp;
  $("#summary-note").textContent =
    `${r.out}: ${toWrite} non-conflicting entr${toWrite === 1 ? "y" : "ies"} will be written` +
    (r.include_unpaired ? ` (including ${unp} found in only one file)` : "; entries found in only one file are left out") +
    (r.conflicts_left ? `, then you decide ${r.conflicts_left} conflict${r.conflicts_left === 1 ? "" : "s"}.` : ".");
  $("#commit").textContent = r.conflicts_left ? `Write them and resolve ${r.conflicts_left} conflict${r.conflicts_left === 1 ? "" : "s"}` : `Write to ${r.out}`;
}

async function commit() {
  $("#commit").disabled = true;
  try {
    const r = await api("/api/compare/commit", {});
    startReview(r);
  } catch (e) {
    setError($("#sum-err"), e.message);
    show("#summary", true);
  } finally {
    $("#commit").disabled = false;
  }
}

// ---------------------------------------------------------------- review

function startReview(r) {
  Object.assign(s, {
    queue: r.queue, total: r.total_conflicts, alreadyDone: r.already_done,
    outName: r.out, pos: 0, maxPos: 0, written: r.written_agreed,
  });
  $("#meta").textContent = `${r.out} · ${r.written_agreed} non-conflicting written`;
  $("#la").textContent = labels.a;
  $("#lb").textContent = labels.b;
  show("#summary", false);
  render();
}

function paintVersions(item) {
  const parts = diffTokens(tokenize(item.a), tokenize(item.b)).parts;
  const fill = (el, keep) => {
    el.replaceChildren(
      ...parts.filter((p) => p.type === "eq" || p.type === keep).map((p) => {
        if (p.type === "eq") return document.createTextNode(p.text);
        const m = document.createElement("mark");
        m.textContent = p.text.replace(/ /g, "␣");
        return m;
      }),
    );
  };
  fill($("#ta"), "del");
  fill($("#tb"), "ins");
  $("#va").classList.toggle("chosen", item.saved?.choice === "a");
  $("#vb").classList.toggle("chosen", item.saved?.choice === "b");
}

function paintStatus(item) {
  const st = $("#status");
  const c = item.saved?.choice;
  st.textContent = c ? `Saved: ${LABEL[c]}` : "";
  st.classList.toggle("flagged", c === "expert");
  show("#status", !!c);
}

function stashDraft() {
  const item = s.queue[s.pos];
  if (item) item.draft = $("#text").value;
}

function loadAudio(item) {
  const audio = $("#au");
  const seq = ++s.loadSeq;
  const keep = new Set();
  for (let i = s.pos - 1; i <= s.pos + PRELOAD_AHEAD; i++) {
    const it = s.queue[i];
    if (it?.audio_ok) { keep.add(it.key); ensure(it.key, it.path); }
  }
  retainOnly(keep);

  if (!item.audio_ok) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    clearWaveform("No audio");
    setError($("#noaudio"), "Audio file not found under the server root. You can still decide from the text.");
    return;
  }
  setError($("#noaudio"), "");
  const cached = ensure(item.key, item.path);
  audio.src = cached.url ?? audioUrl(item.path);
  applySpeed();
  if ($("#autoplay").checked) audio.play().catch(() => {});
  clearWaveform("Loading waveform…");
  cached.buffer
    .then((buf) => { if (seq === s.loadSeq) showWaveform(buf); })
    .catch(() => { if (seq === s.loadSeq) clearWaveform("Couldn't draw waveform (audio still plays)"); });
}

function render() {
  const finished = s.pos >= s.queue.length;
  show("#review", !finished);
  show("#done", finished);
  $("#prog").max = Math.max(s.total, 1);
  $("#prog").value = Math.min(s.alreadyDone + s.pos, s.total);

  if (finished) {
    $("#au").pause();
    const tally = { a: 0, b: 0, manual: 0, expert: 0 };
    for (const it of s.queue) if (it.saved) tally[it.saved.choice]++;
    $("#done-title").textContent = s.queue.length ? "All conflicts resolved" : "Nothing to resolve";
    $("#done-text").textContent = s.queue.length
      ? `${s.queue.length} conflict${s.queue.length === 1 ? "" : "s"} resolved this session ` +
        `(${tally.a} ${labels.a}, ${tally.b} ${labels.b}, ${tally.manual} edited, ${tally.expert} raised to expert). ` +
        `Everything is in ${s.outName}.`
      : `${s.written} non-conflicting entr${s.written === 1 ? "y was" : "ies were"} written to ${s.outName}` +
        (s.alreadyDone ? `; the ${s.alreadyDone} conflict${s.alreadyDone === 1 ? "" : "s"} were already resolved there.` : ". There were no conflicts.");
    show("#done-back", s.queue.length > 0);
    return;
  }

  s.maxPos = Math.max(s.maxPos, s.pos);
  const item = s.queue[s.pos];
  $("#count").textContent = `Conflict ${s.alreadyDone + s.pos + 1} of ${s.total}`;
  $("#path").textContent = item.path;
  $("#back").disabled = s.pos === 0;
  $("#fwd").disabled = s.pos >= s.maxPos;
  setError($("#msg"), "");
  paintVersions(item);
  paintStatus(item);
  $("#text").value = item.draft ?? item.saved?.text ?? item.a;
  loadAudio(item);
  $("#text").focus();
  vimReset();
}

async function save(choice) {
  if (s.busy || s.pos >= s.queue.length) return;
  if (typeof choice !== "string") choice = "manual"; // called by Enter / Vim ZZ / button click
  const item = s.queue[s.pos];
  const text = clean($("#text").value);
  if ((choice === "manual" || choice === "expert") && !text) {
    setError($("#msg"), "The text box is empty.");
    return;
  }
  s.busy = true;
  for (const id of ["#save", "#use-a", "#use-b", "#expert"]) $(id).disabled = true;
  try {
    await api("/api/compare/save", { key: item.key, choice, text: choice === "a" || choice === "b" ? null : text });
    item.saved = { choice, text: choice === "a" ? item.a : choice === "b" ? item.b : text };
    delete item.draft;
    s.pos++;
    render();
  } catch (e) {
    setError($("#msg"), `Not saved: ${e.message}`);
  } finally {
    s.busy = false;
    for (const id of ["#save", "#use-a", "#use-b", "#expert"]) $(id).disabled = false;
  }
}

function back() { if (s.pos > 0) { stashDraft(); s.pos--; render(); } }
function forward() { if (s.pos < s.maxPos && s.pos + 1 < s.queue.length) { stashDraft(); s.pos++; render(); } }

function editFrom(which) {
  const ta = $("#text");
  ta.value = s.queue[s.pos][which];
  ta.focus();
  vimReset();
}

const HOTKEYS = {
  Digit1: () => save("a"),
  Digit2: () => save("b"),
  KeyE: () => save("expert"),
  KeyP: () => togglePlay(),
  KeyR: (e) => (e.shiftKey ? restart() : replay(2)),
  KeyL: () => toggleLoop(),
  ArrowUp: () => stepSpeed(+1),
  ArrowDown: () => stepSpeed(-1),
  ArrowLeft: () => back(),
  ArrowRight: () => forward(),
};

function init() {
  const ta = $("#text");

  // setup
  $("#npath").addEventListener("input", () => { nameTouched = true; $("#m-new").checked = true; });
  $("#rpath").addEventListener("input", () => { $("#m-res").checked = true; });
  const suggest = () => { if (!nameTouched) $("#npath").value = "merged.jsonl"; };
  for (const side of ["a", "b"]) {
    $(`#${side}path`).addEventListener("input", suggest);
    $(`#${side}file`).addEventListener("change", (e) => {
      if (e.target.files[0]) { $(`#${side}path`).value = ""; suggest(); }
    });
  }
  suggest();
  $("#analyze").addEventListener("click", analyze);
  $("#commit").addEventListener("click", commit);
  $("#sum-back").addEventListener("click", () => { show("#summary", false); show("#setup", true); });
  $("#done-again").addEventListener("click", () => location.reload());
  $("#done-back").addEventListener("click", () => { s.pos = s.queue.length - 1; render(); });

  // review
  initWaveform();
  initSymbols();
  initVim({ translate: translateKey, onSave: () => save("manual") });

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && !e.shiftKey) { e.preventDefault(); save("manual"); }
  });
  document.addEventListener("keydown", (e) => {
    if ($("#review").classList.contains("hidden")) return;
    if (e.key === "Escape" && hasSelection()) { clearSelection(); return; }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const act = HOTKEYS[e.code];
    if (act) { e.preventDefault(); act(e); }
  });

  $("#autoplay").checked = pref.get("autoplay", true);
  $("#autoplay").addEventListener("change", (e) => { pref.set("autoplay", e.target.checked); ta.focus(); });

  $("#use-a").addEventListener("click", () => save("a"));
  $("#use-b").addEventListener("click", () => save("b"));
  $("#edit-a").addEventListener("click", () => editFrom("a"));
  $("#edit-b").addEventListener("click", () => editFrom("b"));
  $("#expert").addEventListener("click", () => save("expert"));
  $("#save").addEventListener("click", () => save("manual"));
  $("#back").addEventListener("click", back);
  $("#fwd").addEventListener("click", forward);

  api("/api/files")
    .then(({ root, files }) => {
      $("#root").textContent = root;
      $("#files").replaceChildren(...files.map((f) => Object.assign(document.createElement("option"), { value: f })));
    })
    .catch((e) => setError($("#setup-err"), e.message));
}

init();
