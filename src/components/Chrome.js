// App chrome: the bottom tab bar, the floating add-button, and the toast.
// Props-only presentational components extracted from App.js.
import { useState, useEffect } from "react";
import { UserPlus, MapPin, Upload, X, Plus, Heart, Bell, User } from "lucide-react";

export function FloatingActionButton({ tab, showToast, onAddFriend, onImportMap }) {
  const [open, setOpen] = useState(false);

  // Don't render outside Profile + Map tabs.
  if (tab !== "profile" && tab !== "map") return null;

  const profileOptions = [
    {
      key: "add_friend",
      icon: <UserPlus size={16} />,
      label: "Add friend",
      action: () => {
        setOpen(false);
        onAddFriend();
      },
    },
    {
      key: "add_venue",
      icon: <MapPin size={16} />,
      label: "Add a venue",
      action: () => {
        setOpen(false);
        showToast("Add a venue — coming soon");
      },
    },
    {
      key: "import_map",
      icon: <Upload size={16} />,
      label: "Import a map",
      action: () => {
        setOpen(false);
        onImportMap();
      },
    },
  ];

  const mapOptions = profileOptions.filter((o) => o.key !== "add_friend");
  const options = tab === "profile" ? profileOptions : mapOptions;

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close add menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[3050] bg-black/25"
        />
      )}
      {open && (
        <div className="fixed bottom-[136px] right-4 z-[3060] flex flex-col items-end gap-2">
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={opt.action}
              className="flex items-center gap-2 bg-white border border-neutral-200 rounded-full pl-3 pr-4 py-2 text-sm font-medium shadow-sm active:scale-95 transition"
            >
              <span className="text-neutral-600">{opt.icon}</span>
              <span>{opt.label}</span>
              {opt.soon && (
                <span className="text-[10px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5 font-medium ml-1">
                  soon
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label={open ? "Close add menu" : "Open add menu"}
        onClick={() => setOpen((v) => !v)}
        className={`fixed bottom-20 right-4 z-[3060] w-12 h-12 rounded-full flex items-center justify-center shadow-md active:scale-95 transition ${
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
    <div className="fixed bottom-36 left-1/2 -translate-x-1/2 z-[3070] bg-neutral-900 text-white text-sm font-medium px-4 py-2 rounded-full shadow-lg pointer-events-none">
      {message}
    </div>
  );
}

export function BottomTabBar({ tab, setTab, unreadCount = 0, profileDot = false }) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-[3000] bg-white border-t border-neutral-100 shadow-lg">
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
  );
}
