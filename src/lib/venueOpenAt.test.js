// venueOpenAt (Oct 30, 2026 — the Open-at filter on map, shortlist and
// pick-together). The tricky cases: past-midnight tails and the off state.
import { venueOpenAt, timeStringToMinutes } from "./venueLogic";

const venue = {
  friday_hours: "17:00-01:00", // open Fri evening, spills into Sat morning
  saturday_hours: "12:00-16:00, 17:00-22:30",
  sunday_hours: "Closed",
};

describe("venueOpenAt", () => {
  test("open inside a normal window", () => {
    expect(venueOpenAt(venue, "saturday", timeStringToMinutes("19:00"))).toBe(true);
  });

  test("closed in the gap between windows", () => {
    expect(venueOpenAt(venue, "saturday", timeStringToMinutes("16:30"))).toBe(false);
  });

  test("closed day is closed", () => {
    expect(venueOpenAt(venue, "sunday", timeStringToMinutes("19:00"))).toBe(false);
  });

  test("the previous day's past-midnight tail counts", () => {
    // Friday 5pm-1am means Saturday 00:30 is open (the Friday crowd).
    expect(venueOpenAt(venue, "saturday", timeStringToMinutes("00:30"))).toBe(true);
    expect(venueOpenAt(venue, "saturday", timeStringToMinutes("01:30"))).toBe(false);
  });

  test("no hours data fails the active filter (same stance as Open now)", () => {
    expect(venueOpenAt({}, "friday", timeStringToMinutes("19:00"))).toBe(false);
  });

  test("unset filter always passes", () => {
    expect(venueOpenAt(venue, "", NaN)).toBe(true);
    expect(venueOpenAt(venue, null, undefined)).toBe(true);
  });
});
