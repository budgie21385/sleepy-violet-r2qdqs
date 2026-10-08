// App chrome: the bottom tab bar, the floating add-button, and the toast.
// Props-only presentational components extracted from App.js.
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
// HeartHandshake/ListChecks = the mode icons everywhere (Aug 21, Mark:
// "Why did you not update all the instances" — all-surfaces rule).
import { MapPin, X, Plus, Heart, Bell, User, CalendarDays } from "lucide-react";
import { WhenSheet } from "./WhenSheet";

// THE ONE + (Oct 9 doctrine): the FAB's option menu RETIRED — the + now
// lives on EVERY tab and opens the when-sheet, the single create door
// asking the only question: "When?". Per-tab tilts and extra sections
// live inside WhenSheet.
export function FloatingActionButton({
  tab,
  onNow,
  onComingUp,
  onPast,
  onRightNow,
  onShortlist,
  onAddSpot,
  onImportMap,
  onAddFriend,
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <WhenSheet
          tab={tab}
          onClose={() => setOpen(false)}
          onNow={onNow}
          onComingUp={onComingUp}
          onPast={onPast}
          onRightNow={onRightNow}
          onShortlist={onShortlist}
          onAddSpot={onAddSpot}
          onImportMap={onImportMap}
          onAddFriend={onAddFriend}
        />
      )}
      <button
        type="button"
        aria-label={open ? "Close" : "Add"}
        onClick={() => setOpen((v) => !v)}
        className={`fixed bottom-20 right-4 z-[3060] w-12 h-12 rounded-full flex items-center justify-center shadow-md active:scale-95 transition lg:bottom-[18px] ${
          open ? "bg-neutral-900 text-white" : "bg-[#455d3b] text-white"
        }`}
      >
        {open ? <X size={20} /> : <Plus size={20} />}
      </button>
    </>
  );
}

export function Toast({ message, onDismiss }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 2200);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div className="fixed bottom-36 left-1/2 -translate-x-1/2 z-[5000] bg-neutral-900 text-white text-sm font-medium px-4 py-2 rounded-full shadow-lg pointer-events-none">
      {message}
    </div>
  );
}

export function BottomTabBar({ tab, setTab, unreadCount = 0, profileDot = false }) {
  // PORTALED to body (Aug 1, Mark: "bottom menu is broken when scrolling") —
  // on iOS, a `fixed` element inside any transformed/filtered ancestor anchors
  // to that ANCESTOR instead of the viewport, so the bar scrolled away mid-
  // page. Rendering from document.body means no ancestor can ever capture it.
  //
  // DESKTOP (Sep 6, Mark's Claude-Design mock): at lg+ the phone bar becomes
  // an 84px LEFT RAIL — logo up top, the five tabs as stacked chips, Profile
  // pinned to the bottom. Same component, two CSS layouts, so every tab gets
  // the rail in one move. Content shifts via lg:pl-[84px] on the app shell
  // and lg:left-[84px] on full-bleed screens.
  const railItem = (key, label, icon, extra = "") => (
    <button
      key={key}
      type="button"
      onClick={() => setTab(key)}
      className={`relative flex w-[68px] flex-col items-center gap-1 rounded-[14px] py-2.5 transition ${extra} ${
        tab === key
          ? "bg-[#e7ede3] text-[#455d3b]"
          : "text-neutral-400 hover:bg-[#f2ede5]"
      }`}
    >
      {icon}
      <span className="text-[10.5px] font-medium leading-tight text-center">
        {label}
      </span>
      {key === "activity" && unreadCount > 0 && (
        <span className="absolute top-1.5 right-3 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-red-600 px-1 text-[10.5px] font-semibold text-white">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
      {key === "profile" && profileDot && (
        <span className="absolute top-2 right-4 h-2 w-2 rounded-full bg-red-600" />
      )}
    </button>
  );
  return createPortal(
    <>
    <div className="hidden lg:flex fixed left-0 top-0 bottom-0 z-[3000] w-[84px] flex-col items-center gap-1.5 border-r border-[#ede7df] bg-[#fdf6ef] py-5">
      <div className="mb-4 flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[#455d3b]">
        <MapPin size={15} className="text-[#fdf6ef]" fill="#fdf6ef" />
      </div>
      {railItem("matches", "With friends", <Heart size={20} fill={tab === "matches" ? "#455d3b" : "none"} />)}
      {railItem("map", "Map", <MapPin size={20} fill={tab === "map" ? "#455d3b" : "none"} />)}
      {railItem("activity", "Activity", <Bell size={20} fill={tab === "activity" ? "#455d3b" : "none"} />)}
      {railItem("events", "Events", <CalendarDays size={20} />)}
      {railItem("profile", "Profile", <User size={20} />, "mt-auto")}
    </div>
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-[3000] bg-white border-t border-neutral-100 shadow-lg">
      <div className="flex max-w-md mx-auto">
        <button
          type="button"
          onClick={() => setTab("matches")}
          className={`flex-1 flex flex-col items-center gap-1 py-3 transition ${
            tab === "matches" ? "text-[#455d3b]" : "text-neutral-400"
          }`}
        >
          <Heart
            size={20}
            fill={tab === "matches" ? "#455d3b" : "none"}
          />
          <span className="text-xs font-medium">With friends</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("map")}
          className={`flex-1 flex flex-col items-center gap-1 py-3 transition ${
            tab === "map" ? "text-[#455d3b]" : "text-neutral-400"
          }`}
        >
          <MapPin
            size={20}
            fill={tab === "map" ? "#455d3b" : "none"}
          />
          <span className="text-xs font-medium">Map</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("activity")}
          className={`flex-1 flex flex-col items-center gap-1 py-3 transition ${
            tab === "activity" ? "text-[#455d3b]" : "text-neutral-400"
          }`}
        >
          <span className="relative">
            <Bell size={20} fill={tab === "activity" ? "#455d3b" : "none"} />
            {unreadCount > 0 && (
              <span className="absolute -top-1.5 -right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-red-600 text-white text-[9px] font-medium flex items-center justify-center border-2 border-white">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </span>
          <span className="text-xs font-medium">Activity</span>
        </button>
        {/* EVENTS — fifth tab (Aug 29, Mark confirmed; iOS convention caps
            at five, and Profile collapses to an avatar when Feed arrives,
            per the June nav plan). */}
        <button
          type="button"
          onClick={() => setTab("events")}
          className={`flex-1 flex flex-col items-center gap-1 py-3 transition ${
            tab === "events" ? "text-[#455d3b]" : "text-neutral-400"
          }`}
        >
          <CalendarDays size={20} />
          <span className="text-xs font-medium">Events</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("profile")}
          className={`flex-1 flex flex-col items-center gap-1 py-3 transition ${
            tab === "profile" ? "text-[#455d3b]" : "text-neutral-400"
          }`}
        >
          <span className="relative">
            <User size={20} />
            {profileDot && (
              <span className="absolute -top-1 -right-1.5 h-[10px] w-[10px] rounded-full bg-red-600 border-2 border-white" />
            )}
          </span>
          <span className="text-xs font-medium">Profile</span>
        </button>
      </div>
    </div>
    </>,
    document.body
  );
}
