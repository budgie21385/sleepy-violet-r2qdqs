// Map filter UI — the collapsible filter sheet's building blocks. Self-contained
// leaf components (props only) used by MapScreen. Extracted from App.js.
import { useState, useMemo } from "react";
import { X, Check, ChevronUp, ChevronDown } from "lucide-react";

export function MapFilterGroup({ title, children }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
        {title}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function MapFilterChip({ on, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-sm rounded-full px-3 py-1.5 border transition ${
        on
          ? "bg-[#455d3b] text-white border-[#455d3b]"
          : "bg-white text-neutral-700 border-neutral-200"
      }`}
    >
      {label}
    </button>
  );
}

// Collapsible accordion row used for long filter lists (Area, Cuisine). Shows
// title + a summary ("Any" / "N selected") and a chevron; body renders only
// when expanded so the sheet stays one screen tall.
export function MapFilterSection({ title, summary, accent, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-neutral-100">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between py-3"
      >
        <span className="text-sm font-medium text-neutral-800">{title}</span>
        <span className="flex items-center gap-2">
          <span className={`text-xs ${accent ? "text-[#455d3b]" : "text-neutral-400"}`}>
            {summary}
          </span>
          {open ? (
            <ChevronUp size={16} className="text-neutral-400" />
          ) : (
            <ChevronDown size={16} className="text-neutral-400" />
          )}
        </span>
      </button>
      {open && <div className="pb-4">{children}</div>}
    </div>
  );
}

// A searchable chip list: type to narrow a long set of string options. Used by
// Cuisine. Selected chips stay visible at the top whatever the search term.
export function SearchableChips({ options, selected, onToggle, placeholder }) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const matches = ql
    ? options.filter((o) => o.toLowerCase().includes(ql))
    : options;
  return (
    <div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {selected.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => onToggle(o)}
              className="inline-flex items-center gap-1 text-xs bg-[#edf2eb] text-[#455d3b] rounded-full pl-3 pr-2 py-1"
            >
              {o}
              <X size={12} />
            </button>
          ))}
        </div>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="w-full mb-3 rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:border-[#455d3b]"
      />
      <div className="flex flex-wrap gap-2">
        {matches.map((o) => (
          <MapFilterChip
            key={o}
            on={selected.includes(o)}
            label={o}
            onClick={() => onToggle(o)}
          />
        ))}
        {matches.length === 0 && (
          <p className="text-sm text-neutral-400 py-1">No matches</p>
        )}
      </div>
    </div>
  );
}

// Area picker: selected chips on top, a suburb search, and — when not
// searching — region accordions so the ~120 suburbs browse cleanly.
export function MapAreaFilter({ areas, selected, onToggle }) {
  const [q, setQ] = useState("");
  const [openRegion, setOpenRegion] = useState(null);
  const regions = useMemo(() => {
    const m = new Map();
    areas.forEach((a) => {
      const r = a.region || "Other";
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(a);
    });
    return Array.from(m.entries());
  }, [areas]);
  const ql = q.trim().toLowerCase();
  const searchMatches = ql
    ? areas.filter((a) => a.name.toLowerCase().includes(ql))
    : [];
  const isOn = (a) => selected.some((x) => x.name === a.name);
  return (
    <div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {selected.map((a) => (
            <button
              key={a.name}
              type="button"
              onClick={() => onToggle(a)}
              className="inline-flex items-center gap-1 text-xs bg-[#edf2eb] text-[#455d3b] rounded-full pl-3 pr-2 py-1"
            >
              {a.name}
              <X size={12} />
            </button>
          ))}
        </div>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search suburb"
        className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:border-[#455d3b]"
      />
      {ql ? (
        <div className="mt-2 flex flex-col">
          {searchMatches.map((a) => (
            <button
              key={a.name}
              type="button"
              onClick={() => onToggle(a)}
              className="flex items-center justify-between py-2 px-2 rounded-lg text-sm hover:bg-neutral-50"
            >
              {a.name}
              {isOn(a) && <Check size={15} className="text-[#455d3b]" />}
            </button>
          ))}
          {searchMatches.length === 0 && (
            <p className="text-sm text-neutral-400 py-2 px-2">No matches</p>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-xs font-medium text-neutral-500 mb-1">
            Browse by region
          </p>
          {regions.map(([region, list]) => (
            <div key={region} className="border-t border-neutral-100">
              <button
                type="button"
                onClick={() =>
                  setOpenRegion((o) => (o === region ? null : region))
                }
                className="w-full flex items-center justify-between py-2.5"
              >
                <span className="text-sm text-neutral-700">{region}</span>
                {openRegion === region ? (
                  <ChevronUp size={15} className="text-neutral-400" />
                ) : (
                  <ChevronDown size={15} className="text-neutral-400" />
                )}
              </button>
              {openRegion === region && (
                <div className="flex flex-wrap gap-2 pb-3">
                  {list.map((a) => (
                    <MapFilterChip
                      key={a.name}
                      on={isOn(a)}
                      label={a.name}
                      onClick={() => onToggle(a)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
