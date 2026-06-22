// Google Takeout "Saved places" importer: upload the zip, parse Takeout/Saved
// CSVs, dedupe by CID, preview per-list counts. The actual import POST to the
// enrichment backend is still stubbed (handleImport). Extracted from App.js.
import { useState, useRef } from "react";
import JSZip from "jszip";
import Papa from "papaparse";
import { ArrowLeft, Upload } from "lucide-react";

export function ImportGoogleMapsScreen({ userId, onBack }) {
  // 'idle' | 'parsing' | 'preview' | 'importing' | 'done' | 'error'
  const [stage, setStage] = useState("idle");
  const [error, setError] = useState("");
  const [parsedVenues, setParsedVenues] = useState([]); // [{ title, list, cid, fid }]
  const [perListCounts, setPerListCounts] = useState({}); // { "Bangkok": 75, ... }
  const fileInputRef = useRef(null);

  // Regex extracts FID + CID hex IDs from a Google Maps URL. Same shape as
  // the standalone prototype script — keep these in sync if either changes.
  const URL_PATTERN = /1s(0x[0-9a-f]+):(0x[0-9a-f]+)/;

  async function parseZip(file) {
    setStage("parsing");
    setError("");
    try {
      const zip = await JSZip.loadAsync(file);
      const venues = [];
      const counts = {};
      const entries = Object.values(zip.files).filter(
        (f) =>
          !f.dir &&
          f.name.startsWith("Takeout/Saved/") &&
          f.name.endsWith(".csv") &&
          !f.name.endsWith("Images.csv") // Images.csv = saved web images, not places
      );
      if (entries.length === 0) {
        throw new Error(
          "Couldn't find any Takeout/Saved/*.csv files in this zip. Make sure you exported your Saved Places from Google Takeout."
        );
      }
      for (const entry of entries) {
        const text = await entry.async("string");
        const listName = entry.name
          .split("/")
          .pop()
          .replace(/\.csv$/, "");
        const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
        let count = 0;
        for (const row of data) {
          const title = (row.Title || "").trim();
          const url = (row.URL || "").trim();
          if (!title && !url) continue;
          const m = URL_PATTERN.exec(url);
          const cid = m ? m[2] : "";
          const fid = m ? m[1] : "";
          venues.push({ title, list: listName, cid, fid });
          count++;
        }
        if (count > 0) counts[listName] = count;
      }
      // Dedup by CID — same place tagged in multiple lists collapses into one
      const seen = new Map();
      for (const v of venues) {
        if (!v.cid) continue;
        if (!seen.has(v.cid)) {
          seen.set(v.cid, { ...v, lists: [v.list] });
        } else {
          seen.get(v.cid).lists.push(v.list);
        }
      }
      setParsedVenues([...seen.values()]);
      setPerListCounts(counts);
      setStage("preview");
    } catch (e) {
      console.error("Parse failed:", e);
      setError(e.message || "Couldn't parse the zip. Try again.");
      setStage("error");
    }
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (file) parseZip(file);
  }

  function resetForAnother() {
    setStage("idle");
    setError("");
    setParsedVenues([]);
    setPerListCounts({});
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Stub for the actual import. Will POST chunks to the Edge Function once
  // it's deployed. For now, surface a clear "not yet wired" message so the
  // UI is honest with the user.
  function handleImport() {
    setStage("done");
  }

  const totalLists = Object.keys(perListCounts).length;
  const totalRaw = Object.values(perListCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="fixed inset-0 z-[3500] bg-[#fdf6f0] overflow-y-auto pb-20">
      <div className="max-w-sm mx-auto p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-600"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          Import from Google Maps
        </h1>
        <p className="text-sm text-neutral-600 mb-5">
          Bring your saved places onto your personal Flanit map.
        </p>

        {stage === "idle" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <h2 className="text-base font-semibold tracking-tight mb-2">
              Step 1 — Export from Google
            </h2>
            <ol className="text-sm text-neutral-700 space-y-3 mb-4 list-decimal list-outside ml-5">
              <li>
                Open{" "}
                <a
                  href="https://takeout.google.com/settings/takeout"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#455d3b] underline"
                >
                  Google Takeout
                </a>
                <ul className="list-disc list-outside ml-5 mt-2 space-y-1 text-neutral-600">
                  <li>Click <strong>Deselect all</strong></li>
                  <li>Scroll to the option <strong>Saved</strong> and select (near the bottom)</li>
                  <li>Click <strong>Next step</strong></li>
                  <li>Click <strong>Create export</strong></li>
                </ul>
              </li>
              <li>Download the zip from your email.</li>
              <li>Upload it below.</li>
            </ol>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleFileChange}
              className="hidden"
              id="takeout-zip-input"
            />
            <label
              htmlFor="takeout-zip-input"
              className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white text-center flex items-center justify-center gap-2 cursor-pointer"
            >
              <Upload size={18} /> Choose your Takeout zip
            </label>
          </div>
        )}

        {stage === "parsing" && (
          <div className="rounded-3xl bg-white p-8 shadow-sm border border-neutral-100 text-center">
            <p className="text-sm text-neutral-700">Reading your saved places...</p>
          </div>
        )}

        {stage === "preview" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <h2 className="text-base font-semibold tracking-tight mb-2">
              Found {parsedVenues.length} unique venues
            </h2>
            <p className="text-xs text-neutral-500 mb-4">
              Across {totalLists} list{totalLists === 1 ? "" : "s"} (
              {totalRaw} total entries, deduped)
            </p>
            <div className="max-h-56 overflow-y-auto space-y-1 mb-4 pr-1">
              {Object.entries(perListCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([list, count]) => (
                  <div
                    key={list}
                    className="flex justify-between text-xs py-1 border-b border-neutral-100"
                  >
                    <span className="text-neutral-700 truncate">{list}</span>
                    <span className="text-neutral-500 ml-2 shrink-0">{count}</span>
                  </div>
                ))}
            </div>
            <button
              type="button"
              onClick={handleImport}
              className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white"
            >
              Import these to my map
            </button>
            <button
              type="button"
              onClick={resetForAnother}
              className="w-full mt-2 text-sm text-neutral-500 underline underline-offset-2"
            >
              Choose a different file
            </button>
          </div>
        )}

        {stage === "done" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <h2 className="text-base font-semibold tracking-tight mb-2">
              Almost there
            </h2>
            <p className="text-sm text-neutral-600 mb-3">
              The enrichment backend (Places API lookup + matching) is being
              wired up. Once it's live, this button will finish the import and
              save matches to your map automatically.
            </p>
            <p className="text-xs text-neutral-500 mb-4">
              We parsed {parsedVenues.length} unique venues from your zip — the
              data is ready, just needs a backend trip to finish.
            </p>
            <button
              type="button"
              onClick={resetForAnother}
              className="w-full rounded-2xl bg-white border border-neutral-200 py-3 font-medium text-neutral-700"
            >
              Done
            </button>
          </div>
        )}

        {stage === "error" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <h2 className="text-base font-semibold tracking-tight mb-2 text-red-700">
              Couldn't read that file
            </h2>
            <p className="text-sm text-neutral-600 mb-4">{error}</p>
            <button
              type="button"
              onClick={resetForAnother}
              className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
