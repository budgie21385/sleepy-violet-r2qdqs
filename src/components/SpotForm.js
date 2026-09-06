// SPOT FORM (Sep 6, 2026) — add a spot to the friend knowledge layer.
// Mark's sketch: Cat → Where is it → How to get there → images. One shared
// form; the category only flavors the details placeholder (per-category
// forms deferred until a category needs a real extra field). Where = place
// search (venue coords come free) or plain text + the map centre as the
// pin — a parking area isn't a venue and never should be.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Search, Camera, MapPin } from "lucide-react";
import { supabase } from "../supabaseClient";
import { searchPlaces, callAddVenueApi } from "../lib/venueSearch";
import { uploadSpotPhoto, deleteSpotPhotos } from "../lib/photos";
import { SPOT_CATEGORIES } from "./SpotSheet";

const DETAIL_HINTS = {
  toilet: "Code or key needed? Accessible?",
  study: "Wifi and power? How long can you sit?",
  parking: "Free? Time limit?",
  other: "Anything worth knowing",
};

export function SpotForm({ userId, mapCenter, onClose, onCreated, showToast }) {
  const [category, setCategory] = useState("toilet");
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeResults, setPlaceResults] = useState([]); // [{key, kind:'db'|'google', ...}]
  // picked: {name, venueId|null, lat, lng} — a real pin, however it was found
  const [picked, setPicked] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [directions, setDirections] = useState("");
  const [details, setDetails] = useState("");
  const [files, setFiles] = useState([]); // File[]
  const [previews, setPreviews] = useState([]);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);
  const fileRef = useRef(null);

  // REAL places search (Sep 6, Mark: "we need to be able to pin it to the
  // map") — the app's venues first, Google behind them for anywhere we've
  // never heard of. A Google pick fetches details for coordinates WITHOUT
  // minting a venue row: a toilet's anchor isn't a venue.
  useEffect(() => {
    if (picked) return;
    const term = placeQuery.trim();
    if (term.length < 2) {
      setPlaceResults([]);
      return;
    }
    const mySeq = ++seq.current;
    const timer = setTimeout(async () => {
      const res = await searchPlaces(term, userId).catch(() => null);
      if (mySeq !== seq.current || !res) return;
      setPlaceResults([
        ...res.venues.slice(0, 4).map((v) => ({
          key: `db_${v.id}`,
          kind: "db",
          name: v.name,
          sub: v.suburb || "",
          venue: v,
        })),
        ...res.google.slice(0, 4).map((r) => ({
          key: `g_${r.place_id}`,
          kind: "google",
          name: r.name,
          sub: r.address || "",
          place_id: r.place_id,
        })),
      ]);
    }, 300);
    return () => clearTimeout(timer);
  }, [placeQuery, picked, userId]);

  async function pickResult(r) {
    if (r.kind === "db") {
      setPicked({
        name: r.venue.name,
        venueId: r.venue.id,
        lat: Number(r.venue.latitude),
        lng: Number(r.venue.longitude),
      });
      return;
    }
    setResolving(true);
    try {
      const { card } = await callAddVenueApi({
        action: "details",
        placeId: r.place_id,
      });
      setPicked({
        name: card.name || r.name,
        venueId: null,
        lat: Number(card.lat),
        lng: Number(card.lng),
      });
    } catch (e) {
      console.error("Spot place details failed:", e);
      showToast?.("Couldn't load that place");
    } finally {
      setResolving(false);
    }
  }

  function addFiles(list) {
    const next = Array.from(list || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (next.length === 0) return;
    setFiles((prev) => [...prev, ...next].slice(0, 4));
    setPreviews((prev) =>
      [...prev, ...next.map((f) => URL.createObjectURL(f))].slice(0, 4)
    );
  }

  const canSave = !!picked;

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    const uploaded = [];
    try {
      for (const f of files) {
        uploaded.push(await uploadSpotPhoto(userId, f));
      }
      const placeName = picked.name;
      const catLabel = SPOT_CATEGORIES[category]?.label || "Spot";
      const lat = Number.isFinite(picked.lat) ? picked.lat : mapCenter?.lat;
      const lng = Number.isFinite(picked.lng) ? picked.lng : mapCenter?.lng;
      const { data, error } = await supabase
        .from("spots")
        .insert({
          user_id: userId,
          category,
          title: `${catLabel} at ${placeName}`,
          place_name: placeName,
          venue_id: picked.venueId || null,
          lat: Number.isFinite(lat) ? lat : null,
          lng: Number.isFinite(lng) ? lng : null,
          directions: directions.trim() || null,
          details: details.trim() || null,
          photo_paths: uploaded,
        })
        .select("*")
        .single();
      if (error) throw error;
      showToast?.("Spot added. Your friends can see it now");
      onCreated?.(data);
      onClose();
    } catch (e) {
      console.error("Spot save failed:", e);
      await deleteSpotPhotos(uploaded);
      showToast?.("Couldn't save that spot");
      setSaving(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[3300]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="absolute left-0 right-0 bottom-0 max-h-[90%] flex flex-col rounded-t-3xl bg-white shadow-2xl">
        <div className="px-5 pt-3 pb-2">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Add a spot</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 active:bg-neutral-200"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
          <p className="mt-0.5 text-xs text-neutral-500">
            Only you and your friends will ever see this.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          <p className="mt-2 text-xs font-medium text-neutral-500">What is it?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {Object.entries(SPOT_CATEGORIES)
              .filter(([k]) => k !== "other")
              .concat([["other", SPOT_CATEGORIES.other]])
              .map(([key, c]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategory(key)}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition ${
                    category === key
                      ? "border-[#455d3b] bg-[#edf2eb] text-[#455d3b]"
                      : "border-neutral-200 bg-white text-neutral-500"
                  }`}
                >
                  {c.emoji} {c.label}
                </button>
              ))}
          </div>

          <p className="mt-4 text-xs font-medium text-neutral-500">
            Where is it?
          </p>
          {picked ? (
            <div className="mt-1.5 flex items-center gap-2.5 rounded-2xl bg-[#edf2eb] px-4 py-2.5">
              <MapPin size={15} className="shrink-0 text-[#455d3b]" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-[#455d3b]">
                {picked.name}
              </span>
              <button
                type="button"
                aria-label="Change place"
                onClick={() => {
                  setPicked(null);
                  setPlaceQuery("");
                }}
                className="shrink-0 text-[#455d3b]"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <>
              <div className="mt-1.5 flex h-11 items-center gap-2 rounded-2xl border border-neutral-200 px-3.5">
                <Search size={14} className="shrink-0 text-neutral-400" />
                {/* text-base: sub-16px inputs make iOS Safari auto-zoom. */}
                <input
                  value={placeQuery}
                  onChange={(e) => setPlaceQuery(e.target.value)}
                  placeholder="Sofitel Hotel, a car park, anywhere"
                  className="h-full min-w-0 flex-1 bg-transparent text-base focus:outline-none placeholder:text-neutral-400"
                />
                {resolving && (
                  <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-neutral-200 border-t-[#455d3b]" />
                )}
              </div>
              {placeResults.length > 0 && (
                <div className="mt-1 overflow-hidden rounded-2xl border border-neutral-100">
                  {placeResults.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      disabled={resolving}
                      onClick={() => pickResult(r)}
                      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left active:bg-neutral-50 disabled:opacity-60"
                    >
                      {r.kind === "google" ? (
                        <Search size={13} className="shrink-0 text-neutral-400" />
                      ) : (
                        <MapPin size={13} className="shrink-0 text-neutral-400" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
                        {r.name}
                      </span>
                      <span className="max-w-[40%] shrink-0 truncate text-xs text-neutral-400">
                        {r.sub}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-1 text-[11px] text-neutral-400">
                Search finds anywhere, so the spot pins to the map.
              </p>
            </>
          )}

          <p className="mt-4 text-xs font-medium text-neutral-500">
            How to get there
          </p>
          <textarea
            value={directions}
            onChange={(e) => setDirections(e.target.value)}
            placeholder="Go into the building and up to level 1"
            rows={2}
            maxLength={300}
            className="mt-1.5 w-full resize-none rounded-2xl border border-neutral-200 px-3.5 py-2.5 text-base focus:outline-none focus:border-[#455d3b] placeholder:text-neutral-400"
          />

          <p className="mt-3 text-xs font-medium text-neutral-500">Details</p>
          <input
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder={DETAIL_HINTS[category] || DETAIL_HINTS.other}
            maxLength={200}
            className="mt-1.5 h-11 w-full rounded-2xl border border-neutral-200 px-3.5 text-base focus:outline-none focus:border-[#455d3b] placeholder:text-neutral-400"
          />

          <div className="mt-4 flex items-center gap-2">
            {previews.map((src, i) => (
              <div key={src} className="relative">
                <img
                  src={src}
                  alt=""
                  className="h-16 w-16 rounded-xl object-cover bg-neutral-100"
                />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => {
                    setFiles((prev) => prev.filter((_, j) => j !== i));
                    setPreviews((prev) => prev.filter((_, j) => j !== i));
                  }}
                  className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-white"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {files.length < 4 && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-16 w-16 items-center justify-center rounded-xl border border-dashed border-neutral-300 text-neutral-400"
              >
                <Camera size={18} strokeWidth={1.6} />
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        <div
          className="shrink-0 border-t border-neutral-100 px-5 pt-3"
          style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            disabled={!canSave || saving}
            onClick={save}
            className="w-full rounded-full bg-[#455d3b] py-3.5 text-sm font-medium text-white active:scale-[0.99] transition disabled:opacity-40"
          >
            {saving ? "Saving…" : "Add spot"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
