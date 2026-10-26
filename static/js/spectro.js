// Dependency-free signal helpers: waveform peaks and a wideband spectrogram.

export function monoOf(buffer) {
  const n = buffer.numberOfChannels;
  if (n === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < n; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / n;
  }
  return out;
}

// Min/max per output pixel column, plus the global peak for normalising.
export function peaks(x, width) {
  const data = new Float32Array(width * 2);
  const step = x.length / width;
  let max = 1e-9;
  for (let i = 0; i < width; i++) {
    const a = Math.floor(i * step);
    const b = Math.min(x.length, Math.max(a + 1, Math.floor((i + 1) * step)));
    let lo = 0;
    let hi = 0;
    for (let j = a; j < b; j++) {
      const v = x[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    data[2 * i] = lo;
    data[2 * i + 1] = hi;
    max = Math.max(max, -lo, hi);
  }
  return { data, max };
}

// Iterative radix-2 FFT (in place, forward).
function makeFFT(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * cos[k] + im[l] * sin[k];
          const ti = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  };
}

// Wideband spectrogram (short ~8 ms window: good time resolution for bursts,
// glottal stops and stutter repetitions; formants show as dark bands).
// Returns an ImageData of size cols x bins (row 0 = highest frequency).
export function spectrogram(x, sampleRate, cols, opts = {}) {
  const { maxHz = 8000, winSec = 0.008, dynamicRange = 65, preemph = 0.97 } = opts;
  const win = Math.max(16, Math.round(sampleRate * winSec));
  let N = 1;
  while (N < win * 4) N <<= 1;
  const fft = makeFFT(N);
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));

  const df = sampleRate / N;
  const bins = Math.max(8, Math.floor(Math.min(maxHz, sampleRate / 2) / df));
  const db = new Float32Array(cols * bins);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  let peak = -Infinity;

  for (let c = 0; c < cols; c++) {
    const start = Math.floor(((c + 0.5) / cols) * x.length) - (win >> 1);
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < win; i++) {
      const k = start + i;
      const cur = k >= 0 && k < x.length ? x[k] : 0;
      const prev = k > 0 && k - 1 < x.length ? x[k - 1] : 0;
      re[i] = (cur - preemph * prev) * hann[i];
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const v = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-10);
      db[c * bins + b] = v;
      if (v > peak) peak = v;
    }
  }

  const img = new ImageData(cols, bins);
  const floor = peak - dynamicRange;
  for (let c = 0; c < cols; c++) {
    for (let b = 0; b < bins; b++) {
      const t = Math.min(1, Math.max(0, (db[c * bins + b] - floor) / dynamicRange));
      const g = Math.round(255 * (1 - t));
      const o = ((bins - 1 - b) * cols + c) * 4;
      img.data[o] = g;
      img.data[o + 1] = g;
      img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
  }
  return { img, bins, maxHz: bins * df };
}
