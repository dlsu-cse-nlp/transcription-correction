// Fetches + decodes audio ahead of time so the next sample starts instantly
// and its waveform/spectrogram is ready.

const cache = new Map(); // key -> { url, buffer: Promise<AudioBuffer>, dead }
let ctx = null;

function context() {
  if (!ctx) {
    try {
      ctx = new AudioContext({ sampleRate: 16000 }); // decode straight to 16 kHz: faster spectrogram
    } catch {
      ctx = new AudioContext();
    }
  }
  return ctx;
}

export const audioUrl = (path) => `/audio?p=${encodeURIComponent(path)}`;

export function ensure(key, path) {
  let e = cache.get(key);
  if (e) return e;
  e = { url: null, dead: false, buffer: null };
  e.buffer = fetch(audioUrl(path))
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    })
    .then(async (blob) => {
      const url = URL.createObjectURL(blob);
      if (e.dead) URL.revokeObjectURL(url);
      else e.url = url;
      return context().decodeAudioData(await blob.arrayBuffer());
    });
  e.buffer.catch(() => {}); // consumers handle the error; avoid "unhandled rejection" noise
  cache.set(key, e);
  return e;
}

// Drop everything except the given keys (frees blob URLs).
export function retainOnly(keys) {
  for (const [k, e] of cache) {
    if (keys.has(k)) continue;
    e.dead = true;
    if (e.url) URL.revokeObjectURL(e.url);
    cache.delete(k);
  }
}
