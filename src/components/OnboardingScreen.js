// Post-signup onboarding (pattern "B"): one combined screen to set a username
// and profile photo, shown once after a direct/friend-invite sign-in when the
// profile is still incomplete. Always skippable — never blocks. Anyone who
// skips falls into the nudge state (Profile card + Activity item + tab dot).
import { useState, useEffect, useRef } from "react";
import { supabase } from "../supabaseClient";
import { Camera, Check } from "lucide-react";

export function OnboardingScreen({ userId, profile, setProfile, onDone }) {
  const [displayName, setDisplayName] = useState(profile?.display_name || "");
  const [username, setUsername] = useState(profile?.username || "");
  const [status, setStatus] = useState({ state: "idle" });
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url || "");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  // Debounced username availability check (same rules as the Profile editor).
  useEffect(() => {
    const trimmed = username.trim().toLowerCase();
    if (!trimmed) {
      setStatus({ state: "idle" });
      return;
    }
    if (trimmed.length < 3) {
      setStatus({ state: "tooShort" });
      return;
    }
    if (!/^[a-z0-9_]+$/.test(trimmed)) {
      setStatus({ state: "invalid" });
      return;
    }
    if (trimmed === (profile?.username || "").toLowerCase()) {
      setStatus({ state: "current" });
      return;
    }
    setStatus({ state: "checking" });
    const h = setTimeout(async () => {
      const { data, error: e } = await supabase
        .from("profiles")
        .select("id")
        .eq("username", trimmed)
        .neq("id", userId)
        .maybeSingle();
      if (e) setStatus({ state: "error" });
      else if (data) setStatus({ state: "taken" });
      else setStatus({ state: "available" });
    }, 300);
    return () => clearTimeout(h);
  }, [username, profile?.username, userId]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      // Unique filename per upload so the public URL changes — avoids stale
      // cached avatars when someone replaces their photo.
      const path = `${userId}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) {
        setError("Couldn't upload that photo. Try another.");
        return;
      }
      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      setAvatarUrl(pub.publicUrl);
    } catch {
      setError("Couldn't upload that photo. Try another.");
    } finally {
      setUploading(false);
    }
  }

  const trimmedUsername = username.trim().toLowerCase();
  const usernameValid = status.state === "available" || status.state === "current";
  // Block Done only if they typed a username that isn't valid/available.
  const usernameBlocking =
    !!trimmedUsername && !usernameValid && status.state !== "idle";
  const canDone = !saving && !uploading && !usernameBlocking;

  async function handleDone() {
    setError("");
    const updates = {};
    const trimmedDisplay = displayName.trim();
    if (trimmedDisplay && trimmedDisplay !== (profile?.display_name || ""))
      updates.display_name = trimmedDisplay;
    if (trimmedUsername && usernameValid) updates.username = trimmedUsername;
    if (avatarUrl) updates.avatar_url = avatarUrl;
    if (Object.keys(updates).length === 0) {
      onDone();
      return;
    }
    setSaving(true);
    const { data, error: e } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", userId)
      .select()
      .single();
    setSaving(false);
    if (e) {
      setError(e.message || "Couldn't save. Try again.");
      return;
    }
    if (setProfile) setProfile(data);
    onDone();
  }

  const hint = (() => {
    switch (status.state) {
      case "checking":
        return { text: "Checking…", cls: "text-neutral-400" };
      case "available":
        return { text: `@${trimmedUsername} is available`, cls: "text-[#2f6f3b]" };
      case "current":
        return { text: "That's your username", cls: "text-neutral-400" };
      case "taken":
        return { text: "That one's taken", cls: "text-red-600" };
      case "tooShort":
        return { text: "At least 3 characters", cls: "text-neutral-400" };
      case "invalid":
        return { text: "Letters, numbers and _ only", cls: "text-red-600" };
      default:
        return null;
    }
  })();

  return (
    <div className="fixed inset-0 z-[4000] bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100">
          <h1 className="text-2xl font-semibold tracking-tight text-center">
            Set up your profile
          </h1>
          <p className="mt-1.5 text-sm text-neutral-600 text-center">
            So friends know it's you.
          </p>

          <div className="mt-6 flex flex-col items-center">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="relative h-24 w-24 rounded-full bg-[#edf2eb] flex items-center justify-center overflow-hidden active:scale-95 transition"
              aria-label="Add a photo"
            >
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt="Your avatar"
                  className="h-full w-full object-cover"
                />
              ) : (
                <Camera size={30} className="text-[#455d3b]" />
              )}
              <span className="absolute -right-0.5 -bottom-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-[#455d3b] text-white border-4 border-white text-lg">
                +
              </span>
            </button>
            <p className="mt-2 text-xs font-medium text-[#455d3b]">
              {uploading ? "Uploading…" : avatarUrl ? "Change photo" : "Add a photo"}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFile}
            />
          </div>

          <div className="mt-5">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              maxLength={40}
              className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-base outline-none focus:border-[#455d3b]"
            />
          </div>

          <div className="mt-3">
            <div className="flex items-center rounded-2xl border border-neutral-200 bg-white px-4 py-3 focus-within:border-[#455d3b]">
              <span className="text-neutral-400">@</span>
              <input
                type="text"
                value={username}
                onChange={(e) =>
                  setUsername(e.target.value.replace(/\s/g, "").toLowerCase())
                }
                placeholder="username"
                maxLength={20}
                className="ml-0.5 flex-1 bg-transparent text-base outline-none"
              />
              {usernameValid && <Check size={18} className="text-[#2f6f3b]" />}
            </div>
            {hint && <p className={`mt-2 text-xs ${hint.cls}`}>{hint.text}</p>}
          </div>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <button
            type="button"
            onClick={handleDone}
            disabled={!canDone}
            className="mt-6 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Done"}
          </button>
        </div>
        <button
          type="button"
          onClick={onDone}
          className="mt-3 w-full text-center text-sm text-neutral-500"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
