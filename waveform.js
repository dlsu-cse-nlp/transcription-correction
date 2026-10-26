import { $, pref } from "./util.js";
import { monoOf, peaks, spectrogram } from "./spectro.js";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const WAVE_H = 70; // css px
const SPEC_H = 150;
const RULER_H = 18;

let samples = null;
let dur = 0;
let spec = null; // { canvas, bins, maxHz } offscreen spectrogram image
let sel = null; // { start, end } seconds
let raf = 0;
let speed = pref.get("speed", 1);
let loop = pref.get("loop", true);

const audio = () => $("#au");

// ---------- drawing ----------

function sizeCanvas(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.parentElement.clientWidth * dpr));
  canvas.width = w;
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return { ctx, w, h: canvas.height, dpr };
}

function drawWave() {
  const { ctx, w, h } = sizeCanvas($("#wv-wave"), WAVE_H);
  if (!samples) return;
  const { data, max } = peaks(samples, w);
  const mid = h / 2;
  const scale = (h / 2) * 0.92 / max;
  ctx.fillStyle = "#2a5db0";
  for (let i = 0; i < w; i++) {
    const lo = data[2 * i] * scale;
    const hi = data[2 * i + 1] * scale;
    ctx.fillRect(i, mid - hi, 1, Math.max(1, hi - lo));
  }
}

function drawSpec() {
  const { ctx, w, h, dpr } = sizeCanvas($("#wv-spec"), SPEC_H);
  if (!spec) return;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(spec.canvas, 0, 0, w, h);
  // frequency ticks every 1 kHz, labels on even kHz
  ctx.font = `${10 * dpr}px sans-serif`;
  ctx.textBaseline = "top";
  for (let hz = 1000; hz < spec.maxHz; hz += 1000) {
    const y = h - (hz / spec.maxHz) * h;
    ctx.fillStyle = "rgba(200,0,0,0.55)";
    ctx.fillRect(0, y, 5 * dpr, 1);
    if (hz % 2000 === 0) {
      ctx.fillStyle = "rgba(200,0,0,0.85)";
      ctx.fillText(`${hz / 1000}k`, 7 * dpr, y + 1 * dpr);
    }
  }
}

function drawRuler() {
  const { ctx, w, h, dpr } = sizeCanvas($("#wv-ruler"), RULER_H);
  if (!dur) return;
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
  const pxPerSec = w / dur;
  const step = steps.find((s) => s * pxPerSec >= 60 * dpr) ?? 10;
  ctx.fillStyle = "#555";
  ctx.font = `${10 * dpr}px sans-serif`;
  ctx.textBaseline = "top";
  for (let t = 0; t <= dur; t += step) {
    const x = Math.round(t * pxPerSec);
    ctx.fillRect(x, 0, 1, 5 * dpr);
    ctx.fillText(`${t.toFixed(step < 1 ? 2 : 0)}s`, x + 3 * dpr, 4 * dpr);
  }
}

function draw() {
  drawWave();
  drawSpec();
  drawRuler();
}

// ---------- overlay: selection + playhead ----------

const pct = (t) => `${(100 * t) / (dur || 1)}%`;

function updateHead() {
  $("#wv-head").style.left = pct(Math.min(audio().currentTime, dur));
}

function updateSel() {
  const el = $("#wv-sel");
  el.classList.toggle("hidden", !sel);
  if (sel) {
    el.style.left = pct(sel.start);
    el.style.width = `${(100 * (sel.end - sel.start)) / (dur || 1)}%`;
  }
  $("#selinfo").textContent = sel
    ? `${sel.start.toFixed(2)}–${sel.end.toFixed(2)} s (${(sel.end - sel.start).toFixed(2)} s) · Esc to clear`
    : dur
      ? "Drag on the waveform to select and loop a region"
      : "";
}

function tick() {
  raf = 0;
  const a = audio();
  if (sel && !a.paused && a.currentTime >= sel.end) {
    if (loop) a.currentTime = sel.start;
    else {
      a.pause();
      a.currentTime = sel.start;
    }
  }
  updateHead();
  if (!a.paused) raf = requestAnimationFrame(tick);
}

function startTick() {
  if (!raf) raf = requestAnimationFrame(tick);
}

function timeAt(clientX) {
  const r = $("#wave").getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * dur;
}

function onDown(e) {
  if (!dur || e.button !== 0) return;
  e.preventDefault(); // keep keyboard focus in the textbox
  const a = audio();
  const x0 = e.clientX;
  const t0 = timeAt(x0);
  let dragging = false;

  const move = (ev) => {
    if (!dragging && Math.abs(ev.clientX - x0) < 4) return;
    dragging = true;
    const t1 = timeAt(ev.clientX);
    sel = { start: Math.min(t0, t1), end: Math.max(t0, t1) };
    updateSel();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (dragging && sel && sel.end - sel.start >= 0.03) {
      updateSel();
      a.currentTime = sel.start;
    } else {
      sel = null;
      updateSel();
      a.currentTime = t0;
    }
    a.play().catch(() => {});
    updateHead();
    $("#text").focus();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// ---------- public API ----------

export function showWaveform(buffer) {
  samples = monoOf(buffer);
  dur = buffer.duration;
  sel = null;
  const cols = Math.min(2400, Math.max(200, Math.round(dur / 0.004)));
  const s = spectrogram(samples, buffer.sampleRate, cols);
  const off = document.createElement("canvas");
  off.width = s.img.width;
  off.height = s.img.height;
  off.getContext("2d").putImageData(s.img, 0, 0);
  spec = { canvas: off, bins: s.bins, maxHz: s.maxHz };
  $("#wv-msg").textContent = "";
  draw();
  updateSel();
  updateHead();
}

export function clearWaveform(message = "") {
  samples = null;
  spec = null;
  dur = 0;
  sel = null;
  draw();
  updateSel();
  updateHead();
  $("#wv-msg").textContent = message;
}

export function applySpeed() {
  const a = audio();
  a.defaultPlaybackRate = speed;
  a.playbackRate = speed;
  a.preservesPitch = true;
  a.mozPreservesPitch = true;
  a.webkitPreservesPitch = true;
  for (const b of document.querySelectorAll("#speeds button"))
    b.classList.toggle("active", Number(b.dataset.speed) === speed);
}

export function setSpeed(v) {
  speed = v;
  pref.set("speed", v);
  applySpeed();
}

export function stepSpeed(dir) {
  const i = SPEEDS.indexOf(speed);
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? SPEEDS.indexOf(1) : i) + dir))];
  setSpeed(next);
}

export function togglePlay() {
  const a = audio();
  if (a.paused) a.play().catch(() => {});
  else a.pause();
}

// Jump back `seconds` and play (never before the selection start). Shift variant: restart.
export function replay(seconds = 2) {
  const a = audio();
  const floor = sel ? sel.start : 0;
  a.currentTime = Math.max(floor, a.currentTime - seconds);
  a.play().catch(() => {});
}

export function restart() {
  const a = audio();
  a.currentTime = sel ? sel.start : 0;
  a.play().catch(() => {});
}

export function toggleLoop() {
  loop = !loop;
  pref.set("loop", loop);
  $("#loop").checked = loop;
}

export const hasSelection = () => !!sel;

export function clearSelection() {
  sel = null;
  updateSel();
}

export function initWaveform() {
  const a = audio();

  $("#speeds").replaceChildren(
    ...SPEEDS.map((v) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.speed = v;
      b.textContent = `${v}×`;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // don't steal focus from the textbox
      b.addEventListener("click", () => setSpeed(v));
      return b;
    }),
  );
  applySpeed();

  $("#loop").checked = loop;
  $("#loop").addEventListener("change", (e) => {
    loop = e.target.checked;
    pref.set("loop", loop);
    $("#text").focus();
  });
  const rb = $("#replay");
  rb.addEventListener("mousedown", (e) => e.preventDefault());
  rb.addEventListener("click", () => replay(2));

  $("#wave").addEventListener("mousedown", onDown);

  a.addEventListener("play", () => {
    if (sel && (a.currentTime < sel.start || a.currentTime >= sel.end - 0.01)) a.currentTime = sel.start;
    startTick();
  });
  a.addEventListener("ended", () => {
    if (sel && loop) {
      a.currentTime = sel.start;
      a.play().catch(() => {});
    }
    updateHead();
  });
  for (const ev of ["pause", "seeked", "timeupdate", "loadedmetadata"]) a.addEventListener(ev, updateHead);

  let pending = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      draw();
      updateHead();
    });
  }).observe($("#wave"));
}
