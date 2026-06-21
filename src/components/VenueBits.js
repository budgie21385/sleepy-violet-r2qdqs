// Small presentational pieces of a venue card. Props-only leaf components
// extracted from App.js; used by VenueCard and MapVenueSheet.
import { useState } from "react";
import { ExternalLink } from "lucide-react";

export function VenueRating({ venue }) {
  if (!venue.rating && !venue.review_count) return null;
  return (
    <p className="mt-4 text-sm font-medium text-neutral-700">
      ⭐ {venue.rating || "No rating"}
      {venue.review_count
        ? ` · ${venue.review_count} ${
            Number(venue.review_count) === 1 ? "review" : "reviews"
          }`
        : ""}
    </p>
  );
}

export function OpeningHours({ venue }) {
  const [isOpen, setIsOpen] = useState(false);
  const days = [
    { label: "Mon", value: venue.monday_hours },
    { label: "Tue", value: venue.tuesday_hours },
    { label: "Wed", value: venue.wednesday_hours },
    { label: "Thu", value: venue.thursday_hours },
    { label: "Fri", value: venue.friday_hours },
    { label: "Sat", value: venue.saturday_hours },
    { label: "Sun", value: venue.sunday_hours },
  ];
  const todayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
  const today = days[todayIndex];
  return (
    <div className="mt-3 text-sm text-neutral-600">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between rounded-2xl bg-neutral-50 px-4 py-3 text-left"
      >
        <span>
          <strong>Today:</strong> {today.value || "Hours unavailable"}
        </span>
        <span>{isOpen ? "⌃" : "⌄"}</span>
      </button>
      {isOpen && (
        <div className="mt-2 rounded-2xl bg-neutral-50 px-4 py-3">
          {days.map((day) => (
            <div key={day.label} className="flex justify-between py-1">
              <span className="font-medium">{day.label}</span>
              <span>{day.value || "Hours unavailable"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function OpenMapsButton({ url }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-neutral-200 bg-white py-4 font-medium text-neutral-800"
    >
      Open in Maps <ExternalLink size={17} />
    </a>
  );
}
