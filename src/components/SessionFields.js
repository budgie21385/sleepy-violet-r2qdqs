// Small form-field components for the filters / session-setup screens:
// the When toggle, area checkbox, multi-select chips, and the match-count,
// participants, and time-limit pickers. Props-only. Extracted from App.js.
import { useState } from "react";
import { ALL, MATCH_OPTIONS, PARTICIPANT_OPTIONS } from "../lib/constants";

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

export function MatchLimitField({ value, onChange }) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">
        How many matches?
      </span>
      <div className="grid grid-cols-4 gap-2">
        {MATCH_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`rounded-2xl py-3 font-medium transition ${
              value === option
                ? "bg-[#455d3b] text-white"
                : "bg-neutral-50 text-neutral-700 border border-neutral-100"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

// Segmented-pill control (matches the map's All / My List toggle): a rounded
// track with the selected option lifted to a white pill.
function SegmentedField({ label, children }) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">
        {label}
      </span>
      <div className="flex gap-0.5 rounded-full bg-neutral-100 p-0.5">
        {children}
      </div>
    </div>
  );
}

function SegmentButton({ on, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-full py-2 text-sm font-medium transition ${
        on ? "bg-white text-[#455d3b] shadow-sm" : "text-neutral-500"
      }`}
    >
      {children}
    </button>
  );
}

export function ParticipantsField({ value, onChange }) {
  return (
    <SegmentedField label="How many of us?">
      {PARTICIPANT_OPTIONS.map((option) => (
        <SegmentButton
          key={option}
          on={value === option}
          onClick={() => onChange(option)}
        >
          {option}
        </SegmentButton>
      ))}
    </SegmentedField>
  );
}

export function TimeLimitField({ value, onChange, options }) {
  return (
    <SegmentedField label="Time limit">
      {options.map((option) => (
        <SegmentButton
          key={option.minutes}
          on={value === option.minutes}
          onClick={() => onChange(option.minutes)}
        >
          {option.label}
        </SegmentButton>
      ))}
    </SegmentedField>
  );
}
