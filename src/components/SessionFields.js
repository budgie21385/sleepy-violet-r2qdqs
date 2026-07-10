// Small form-field components for the filters / session-setup screens:
// the When toggle, area checkbox, multi-select chips, and the dropdown row.
// Props-only. Extracted from App.js.
//
// July 9, 2026 setup redesign: ParticipantsField and TimeLimitField removed
// (dead controls — participants fed nothing; time limit wrote an expires_at
// nothing enforces). MatchLimitField and RadiusField replaced by DropdownField
// rows (single-choice pills → dropdowns, per Mark).
import { useState } from "react";
import { ALL } from "../lib/constants";

export function OpenNowToggle({ openNow, setOpenNow }) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">When?</span>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setOpenNow(false)}
          className={`rounded-2xl py-3 font-medium transition ${
            !openNow
              ? "bg-[#455d3b] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Any time
        </button>
        <button
          type="button"
          onClick={() => setOpenNow(true)}
          className={`rounded-2xl py-3 font-medium transition ${
            openNow
              ? "bg-[#455d3b] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Open now
        </button>
      </div>
    </div>
  );
}

export function AreaCheckbox({ state }) {
  return (
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
        state === "all"
          ? "border-[#455d3b] bg-[#455d3b]"
          : state === "some"
          ? "border-[#455d3b] bg-white"
          : "border-neutral-300 bg-white"
      }`}
    >
      {state === "all" && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2 6L5 9L10 3"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {state === "some" && <span className="block h-0.5 w-2.5 bg-[#455d3b]" />}
    </span>
  );
}

export function MultiSelectChips({ label, options, selected, setSelected }) {
  const [isOpen, setIsOpen] = useState(false);
  function toggleOption(option) {
    if (option === ALL) {
      setSelected([]);
      setIsOpen(false);
      return;
    }
    if (selected.includes(option)) {
      setSelected(selected.filter((item) => item !== option));
    } else {
      setSelected([...selected, option]);
    }
  }
  const buttonText =
    selected.length === 0
      ? "All"
      : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`;
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full rounded-2xl bg-neutral-50 px-4 py-4 text-left text-base border border-neutral-100"
      >
        {buttonText} <span className="float-right">⌄</span>
      </button>
      {isOpen && (
        <div className="mt-3 flex flex-wrap gap-2 rounded-2xl bg-white p-3 border border-neutral-100 shadow-sm">
          <button
            type="button"
            onClick={() => toggleOption(ALL)}
            className={`rounded-full px-4 py-2 text-sm font-medium border ${
              selected.length === 0
                ? "bg-[#455d3b] text-white border-[#455d3b]"
                : "bg-neutral-50 text-neutral-700 border-neutral-100"
            }`}
          >
            All
          </button>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => toggleOption(option)}
              className={`rounded-full px-4 py-2 text-sm font-medium border ${
                selected.includes(option)
                  ? "bg-[#455d3b] text-white border-[#455d3b]"
                  : "bg-neutral-50 text-neutral-700 border-neutral-100"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact labelled dropdown row: label left, native select right. Replaces
// the old segmented-pill fields (Radius, How many matches) — the native
// select keeps the row one line tall and behaves well on mobile.
export function DropdownField({ label, value, onChange, options }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-neutral-50 border border-neutral-100 px-4 py-3">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(options[e.target.selectedIndex].value)}
        className="bg-transparent text-sm font-medium text-neutral-900 text-right focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
