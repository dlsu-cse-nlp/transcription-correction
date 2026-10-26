// Token-level diff between the original and the edited phoneme string.

// A token is one phoneme symbol: base char (+ tie bar + second char) plus any
// combining marks / length / aspiration modifiers. Whitespace chars are tokens too.
// Stress marks (ˈ ˌ) are deliberately NOT attached to the previous symbol.
const TOKEN = /\S\u0361\S[\u0300-\u036F\u02D0\u02B0\u02B7]*|\S[\u0300-\u036F\u02D0\u02B0\u02B7]*|\s/gu;

export const tokenize = (s) => s.match(TOKEN) ?? [];

export function diffTokens(a, b) {
  const n = a.length;
  const m = b.length;
  // LCS table
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: "eq", t: a[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) ops.push({ type: "del", t: a[i++] });
    else ops.push({ type: "ins", t: b[j++] });
  }
  while (i < n) ops.push({ type: "del", t: a[i++] });
  while (j < m) ops.push({ type: "ins", t: b[j++] });

  // Merge into runs; inside each change hunk, show deletions before insertions.
  const out = [];
  let hunks = 0;
  for (let k = 0; k < ops.length; ) {
    if (ops[k].type === "eq") {
      let s = "";
      while (k < ops.length && ops[k].type === "eq") s += ops[k++].t;
      out.push({ type: "eq", text: s });
    } else {
      let del = "";
      let ins = "";
      while (k < ops.length && ops[k].type !== "eq") {
        if (ops[k].type === "del") del += ops[k].t; else ins += ops[k].t;
        k++;
      }
      if (del) out.push({ type: "del", text: del });
      if (ins) out.push({ type: "ins", text: ins });
      hunks++;
    }
  }
  return { parts: out, hunks };
}

const visible = (s) => s.replace(/ /g, "␣");

// Renders into `el`; returns the number of changed hunks.
export function renderDiff(el, original, edited) {
  const { parts, hunks } = diffTokens(tokenize(original), tokenize(edited));
  el.replaceChildren(
    ...parts.map((p) => {
      const span = document.createElement(p.type === "eq" ? "span" : p.type);
      span.textContent = p.type === "eq" ? p.text : visible(p.text);
      return span;
    }),
  );
  return hunks;
}
