import { $, api, setError } from "./util.js";

const s = { queue: [], pos: 0, total: 0, alreadyDone: 0, outName: "", busy: false };
const original = (item) => item.entry.text ?? "";

export function startReview({ queue, total, alreadyDone, outName, meta }) {
  Object.assign(s, { queue, total, alreadyDone, outName, pos: 0 });
  $("#meta").textContent = meta;
  render();
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

  const item = s.queue[s.pos];
  $("#count").textContent = `${s.alreadyDone + s.pos + 1} of ${s.total}`;
  $("#path").textContent = item.entry.audio_filepath;
  $("#back").disabled = s.pos === 0;
  setError($("#msg"), "");

  if (item.audio_ok) {
    setError($("#noaudio"), "");
    audio.src = `/audio?p=${encodeURIComponent(item.entry.audio_filepath)}`;
    if ($("#autoplay").checked) audio.play().catch(() => {});
  } else {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    setError($("#noaudio"), "Audio file not found under the server root. You can still edit and save the text.");
  }

  $("#text").value = item.saved ?? original(item);
  updateEdited();
  $("#text").focus();
}

function updateEdited() {
  const orig = original(s.queue[s.pos]);
  const changed = $("#text").value !== orig;
  for (const id of ["#edited", "#reset", "#orig"]) $(id).classList.toggle("hidden", !changed);
  $("#orig").textContent = changed ? `Original: ${orig}` : "";
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
  if (s.pos > 0) { s.pos--; render(); }
}

export function initReview() {
  const textarea = $("#text");
  const audio = $("#au");

  textarea.addEventListener("input", updateEdited);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && !e.shiftKey) { e.preventDefault(); save(); }
  });
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || $("#review").classList.contains("hidden")) return;
    if (e.key.toLowerCase() === "p") {
      e.preventDefault();
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      back();
    }
  });

  $("#save").addEventListener("click", save);
  $("#back").addEventListener("click", back);
  $("#reset").addEventListener("click", () => {
    textarea.value = original(s.queue[s.pos]);
    updateEdited();
    textarea.focus();
  });
  $("#done-back").addEventListener("click", () => { s.pos = s.queue.length - 1; render(); });
}
