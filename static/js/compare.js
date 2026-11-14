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
// Blind review: nothing on this page names an annotator. Which transcription is shown on the left
// is decided per entry by the server (item.swap) and undone only when the choice is sent back.
const LABEL = { a: "version 1", b: "version 2", manual: "your edit", merge: "merged by differences", expert: "raised to expert" };
const flip = (c) => (c === "a" ? "b" : c === "b" ? "a" : c);
const NUM = { a: "1", b: "2" };

// ---------------------------------------------------------------- setup

let nameTouched = false;
const labels = { a: "file 1", b: "file 2" }; // setup order only; real file names are never shown in review

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
    const { name: _an, ...aReq } = a;
    const { name: _bn, ...bReq } = b;
    $("#analyze").disabled = true;
    const r = await api("/api/compare/load", {
      ...aReq, ...bReq, mode, out_path: outPath, include_unpaired: $("#unpaired").checked,
      order: $("#easy").checked ? "easy" : "file",
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
  if (r.hunks) {
    const pc = (n, d) => `${n} (${Math.round((100 * n) / d)}%)`;
    rows.push(
      ["Word-level differences to settle", r.hunks, "hl"],
      ["…with a suggestion", pc(r.hunks_suggested, r.hunks), "sub"],
      ["…distinct A/B pairs (repeats decided once)", r.unique_pairs, "sub"],
      ["Conflicts where every difference has a suggestion", r.tier0, "sub"],
      ["Conflicts with some suggestions", r.tier1, "sub"],
      ["Conflicts with none (need your ears)", r.tier2, "sub"],
    );
  }
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

// Show B on the left for entries the server marked `swap`, and rewrite the differences to match.
function blind(it) {
  if (!it.swap) return it;
  [it.a, it.b] = [it.b, it.a];
  const lab = { A: "version 2", B: "version 1" }; // where the file-A / file-B reasons now sit
  it.parts = it.parts.map((p) => p.t !== "h" ? p : {
    ...p, a: p.b, b: p.a, sug: flip(p.sug), why: (p.why ?? "").replace(/\{([AB])\}/g, (_, x) => lab[x]),
  });
  return it;
}

function showTally(r) {
  s.expert = r.expert;
  s.edited = r.edited;
  $("#expcount").textContent = r.expert;
  $("#editcount").textContent = r.edited;
}

function startReview(r) {
  for (const it of r.queue) {
    if (!it.swap) it.parts = it.parts.map((p) => p.t !== "h" ? p : {
      ...p, why: (p.why ?? "").replace(/\{([AB])\}/g, (_, x) => (x === "A" ? "version 1" : "version 2")),
    });
    blind(it);
    Object.assign(it, { pick: {}, active: 0, custom: false });
  }
  Object.assign(s, {
    queue: r.queue, total: r.total_conflicts, alreadyDone: r.already_done,
    outName: r.out, pos: 0, maxPos: 0, written: r.written_agreed, editLog: r.edit_log,
  });
  $("#meta").textContent = `${r.out} · ${r.written_agreed} non-conflicting written`;
  $("#editlog").textContent = `(edited entries are listed in ${r.edit_log})`;
  showTally(r);
  $("#la").textContent = "Version 1";
  $("#lb").textContent = "Version 2";
  show("#summary", false);
  render();
}

// ---- word-level differences ----------------------------------------------

// What you chose earlier for the same A/B word pair (stored as the chosen spelling, so A/B order doesn't matter).
const memory = new Map(Object.entries(pref.get("cmpmem", {})));
function remember(h, side) {
  memory.set(h.pair, h[side].join(" "));
  pref.set("cmpmem", Object.fromEntries([...memory].slice(-5000)));
}

function suggestion(h) {
  const seen = memory.get(h.pair);
  if (seen !== undefined) {
    const side = seen === h.a.join(" ") ? "a" : seen === h.b.join(" ") ? "b" : null;
    if (side) return { pick: side, why: "you chose this earlier" };
  }
  return { pick: h.sug, why: h.why };
}

const hunksOf = (item) => item.parts.filter((p) => p.t === "h");
const undecided = (item) => hunksOf(item).filter((h) => item.pick[h.id] === undefined);

function compose(item, fill = () => "a") {
  const words = [];
  for (const p of item.parts) {
    if (p.t === "eq") words.push(...p.w);
    else words.push(...p[item.pick[p.id] ?? fill(p)]);
  }
  return words.join(" ");
}

function marked(x, y, keep) {
  return diffTokens(tokenize(x), tokenize(y)).parts
    .filter((p) => p.type === "eq" || p.type === keep)
    .map((p) => {
      if (p.type === "eq") return document.createTextNode(p.text);
      const m = document.createElement("mark");
      m.textContent = p.text.replace(/ /g, "␣");
      return m;
    });
}

function paintVersions(item) {
  $("#ta").replaceChildren(...marked(item.a, item.b, "del"));
  $("#tb").replaceChildren(...marked(item.a, item.b, "ins"));
  $("#va").classList.toggle("chosen", item.saved?.choice === "a");
  $("#vb").classList.toggle("chosen", item.saved?.choice === "b");
}

function chip(item, h, side, sug) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `chip ${side}`;
  b.classList.toggle("sel", item.pick[h.id] === side);
  b.classList.toggle("sug", sug.pick === side);
  const k = document.createElement("small");
  k.textContent = NUM[side];
  const fa = h.a.join(" ");
  const fb = h.b.join(" ");
  const form = side === "a" ? fa : fb;
  b.append(k);
  if (!form) b.append("∅");
  else b.append(...marked(fa, fb, side === "a" ? "del" : "ins"));
  b.title = sug.pick === side && sug.why ? `Suggested: ${sug.why}` : "";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => pickHunk(h.id, side));
  return b;
}

function paintHunks() {
  const item = s.queue[s.pos];
  if (!item) return;
  const hs = hunksOf(item);
  const box = $("#hunks");
  box.replaceChildren(
    ...item.parts.map((p, i) => {
      if (p.t !== "h") return null;
      const row = document.createElement("div");
      row.className = "hunk";
      row.classList.toggle("active", item.active === p.id);
      row.classList.toggle("decided", item.pick[p.id] !== undefined);
      const sug = suggestion(p);
      const prev = item.parts[i - 1]?.w?.at(-1);
      const next = item.parts[i + 1]?.w?.[0];
      const ctx = (t) => Object.assign(document.createElement("span"), { className: "ctx", textContent: t });
      row.append(...(prev ? [ctx(`…${prev}`)] : []), chip(item, p, "a", sug), chip(item, p, "b", sug), ...(next ? [ctx(`${next}…`)] : []));
      if (p.repeats > 1) {
        const r = Object.assign(document.createElement("span"), { className: "badge", textContent: `×${p.repeats}` });
        r.title = `This A/B pair occurs ${p.repeats} times in this comparison; deciding once pre-fills the rest.`;
        row.append(r);
      }
      if (sug.pick && sug.why) row.append(Object.assign(document.createElement("span"), { className: "why", textContent: `★ ${sug.why}` }));
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        item.active = p.id;
        paintHunks();
      });
      return row;
    }).filter(Boolean),
  );
  const left = undecided(item).length;
  const sugs = hs.filter((h) => item.pick[h.id] === undefined && suggestion(h).pick).length;
  $("#hunkinfo").textContent = `${hs.length} · ${hs.length - left} decided · ${sugs} suggested`;
  show("#customnote", item.custom);
  $("#hunkcard").classList.toggle("hidden", hs.length === 0);
}

function syncText(item) {
  if (item.custom) return;
  $("#text").value = compose(item);
  vimReset();
}

function nextUndecided(item, from) {
  const hs = hunksOf(item);
  const order = [...hs.slice(from + 1), ...hs.slice(0, from + 1)];
  return order.find((h) => item.pick[h.id] === undefined)?.id ?? item.active;
}

function pickHunk(id, side) {
  const item = s.queue[s.pos];
  const h = item?.parts.find((p) => p.t === "h" && p.id === id);
  if (!h) return;
  item.pick[id] = side;
  remember(h, side);
  item.custom = false;
  item.active = nextUndecided(item, id);
  syncText(item);
  paintHunks();
  $("#text").focus();
}

function moveActive(dir) {
  const item = s.queue[s.pos];
  const n = hunksOf(item).length;
  if (!n) return;
  item.active = (item.active + dir + n) % n;
  paintHunks();
}

function applySuggestions(item) {
  for (const h of hunksOf(item)) {
    const sg = suggestion(h).pick;
    if (item.pick[h.id] === undefined && sg) { item.pick[h.id] = sg; remember(h, sg); }
  }
  item.custom = false;
  item.active = hunksOf(item).find((h) => item.pick[h.id] === undefined)?.id ?? item.active;
  syncText(item);
  paintHunks();
}

function acceptSuggestions() {
  const item = s.queue[s.pos];
  applySuggestions(item);
  const left = undecided(item).length;
  if (left) setError($("#msg"), `${left} difference${left === 1 ? " has" : "s have"} no suggestion. Decide ${left === 1 ? "it" : "them"} yourself, then save.`);
  else save("manual");
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
    const tally = { a: 0, b: 0, manual: 0, merge: 0, expert: 0 };
    for (const it of s.queue) if (it.saved) tally[it.saved.choice]++;
    $("#done-title").textContent = s.queue.length ? "All conflicts resolved" : "Nothing to resolve";
    $("#done-text").textContent = s.queue.length
      ? `${s.queue.length} conflict${s.queue.length === 1 ? "" : "s"} resolved this session ` +
        `(${tally.a + tally.b} picked one version as-is, ${tally.merge} merged by differences, ${tally.manual} edited, ${tally.expert} raised to expert). ` +
        `${s.expert} entr${s.expert === 1 ? "y is" : "ies are"} flagged for the expert in total, and ${s.edited} edited beyond picking (listed in ${s.editLog}). ` +
        `Everything is in ${s.outName}.`
      : `${s.written} non-conflicting entr${s.written === 1 ? "y was" : "ies were"} written to ${s.outName}` +
        (s.alreadyDone ? `; the ${s.alreadyDone} conflict${s.alreadyDone === 1 ? "" : "s"} were already resolved there.` : ". There were no conflicts.");
    show("#done-back", s.queue.length > 0);
    return;
  }

  s.maxPos = Math.max(s.maxPos, s.pos);
  const item = s.queue[s.pos];
  const nh = hunksOf(item).length;
  $("#count").textContent = `Conflict ${s.alreadyDone + s.pos + 1} of ${s.total} · ${nh} difference${nh === 1 ? "" : "s"}`;
  $("#path").textContent = item.path;
  $("#back").disabled = s.pos === 0;
  $("#fwd").disabled = s.pos >= s.maxPos;
  setError($("#msg"), "");
  if (item.draft === undefined && item.saved && item.saved.choice !== "merge") item.custom = true;
  paintVersions(item);
  paintStatus(item);
  paintHunks();
  $("#text").value = item.draft ?? (item.custom ? item.saved?.text ?? item.a : compose(item));
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
  if (choice === "manual") {
    if (!item.custom) {
      const left = undecided(item).length;
      if (left) {
        setError($("#msg"), `${left} difference${left === 1 ? " is" : "s are"} still undecided. Pick version 1 or 2 for ${left === 1 ? "it" : "each"} (Alt+S applies suggestions), or edit the text box by hand.`);
        return;
      }
      choice = "merge";
    }
  }
  s.busy = true;
  for (const id of ["#save", "#use-a", "#use-b", "#expert"]) $(id).disabled = true;
  try {
    // `choice` is what the page shows (version 1/2); the server knows the real files, so undo the swap
    const sent = item.swap ? flip(choice) : choice;
    const r = await api("/api/compare/save", { key: item.key, choice: sent, text: choice === "a" || choice === "b" ? null : text });
    showTally(r);
    item.saved = { choice, text: choice === "a" ? item.a : choice === "b" ? item.b : text };
    if (choice === "manual") item.custom = true;
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

function pickActive(side) {
  const item = s.queue[s.pos];
  if (hunksOf(item).length) pickHunk(item.active, side);
}

function editFrom(which) {
  const ta = $("#text");
  ta.value = s.queue[s.pos][which];
  s.queue[s.pos].custom = true;
  paintHunks();
  ta.focus();
  vimReset();
}

const HOTKEYS = {
  Digit1: (e) => (e.shiftKey ? save("a") : pickActive("a")),
  Digit2: (e) => (e.shiftKey ? save("b") : pickActive("b")),
  KeyS: () => applySuggestions(s.queue[s.pos]),
  KeyA: () => acceptSuggestions(),
  KeyJ: () => moveActive(+1),
  KeyK: () => moveActive(-1),
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

  ta.addEventListener("input", () => {
    const item = s.queue[s.pos];
    if (item && !item.custom) { item.custom = true; paintHunks(); }
  });
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
  $("#apply-sug").addEventListener("click", () => applySuggestions(s.queue[s.pos]));
  $("#accept-sug").addEventListener("click", acceptSuggestions);
  $("#resync").addEventListener("click", () => { const it = s.queue[s.pos]; it.custom = false; syncText(it); paintHunks(); });
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
