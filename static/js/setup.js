import { $, api, setError } from "./util.js";
import { startReview } from "./review.js";

let nameTouched = false;

function suggestName(fileName) {
  if (nameTouched || !fileName) return;
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  $("#npath").value = `${stem}_reviewed.jsonl`;
}

function summarize(result) {
  const notes = [];
  if (result.missing_audio)
    notes.push(`${result.missing_audio} audio file(s) not found`);
  if (result.ignored_lines)
    notes.push(
      `${result.ignored_lines} unreadable line(s) in the progress file ignored`,
    );
  if (result.invalid_entries)
    notes.push(
      `${result.invalid_entries} manifest entries without audio_filepath skipped`,
    );
  return [result.out, ...notes].join(" · ");
}

async function start() {
  const err = $("#setup-err");
  setError(err, "");
  const mode = document.querySelector("input[name=mode]:checked").value;
  const request = {
    mode,
    out_path: $(mode === "resume" ? "#rpath" : "#npath").value.trim(),
  };
  const file = $("#mfile").files[0];
  try {
    if (file) request.manifest_text = await file.text();
    else request.manifest_path = $("#mpath").value.trim();
    if (!file && !request.manifest_path)
      throw new Error("Choose a manifest file.");
    if (!request.out_path) {
      throw new Error(
        mode === "resume"
          ? "Choose the progress file to resume."
          : "Enter a name for the new progress file.",
      );
    }
    $("#start").disabled = true;
    const result = await api("/api/load", request);
    $("#setup").classList.add("hidden");
    startReview({
      queue: result.queue,
      total: result.total,
      alreadyDone: result.already_done,
      outName: result.out,
      meta: summarize(result),
    });
  } catch (e) {
    setError(err, e.message);
  } finally {
    $("#start").disabled = false;
  }
}

export async function initSetup() {
  $("#npath").addEventListener("input", () => {
    nameTouched = true;
    $("#m-new").checked = true;
  });
  $("#rpath").addEventListener("input", () => {
    $("#m-res").checked = true;
  });
  $("#mpath").addEventListener("input", (e) => suggestName(e.target.value));
  $("#mfile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      $("#mpath").value = "";
      suggestName(file.name);
    }
  });
  $("#start").addEventListener("click", start);

  try {
    const { root, files } = await api("/api/files");
    $("#root").textContent = root;
    $("#files").replaceChildren(
      ...files.map((f) =>
        Object.assign(document.createElement("option"), { value: f }),
      ),
    );
  } catch (e) {
    setError($("#setup-err"), e.message);
  }
}
