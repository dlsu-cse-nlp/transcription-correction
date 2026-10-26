export const $ = (selector) => document.querySelector(selector);

export async function api(path, body) {
  const res = await fetch(path, body && {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "The server rejected the request.");
  }
  return data;
}

export function setError(el, message) {
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

// Small persisted preferences (speed, loop, ...). Fails silently if storage is unavailable.
export const pref = {
  get(name, fallback) {
    try {
      const v = localStorage.getItem(`pc.${name}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(name, value) {
    try {
      localStorage.setItem(`pc.${name}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};
