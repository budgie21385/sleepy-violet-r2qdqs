// GUEST HOME — the wall an anonymous session hits at the app root (July 31,
// 2026; Mark: "They shouldn't be able to get through to the app").
//
// WHY THIS EXISTS. Anonymous auth gives a guest a real row in auth.users, and
// the collect-link name door then writes them a profiles row via set_guest_name.
// From that moment they were indistinguishable from a member: the Profile tab
// rendered, the tier chip said "Member", and all four tabs were reachable —
// over a session that lives only in that browser's storage and can vanish with
// it. Nothing warned them, and nothing invited them to become real.
//
// Anon is welcome on the two links designed for strangers — /c/<token> and
// /s/<uuid>, both of which render before the app shell — and gated everywhere
// else. That's the whole rule.
//
// The conversion is the SAME mechanism CollectScreen uses, deliberately: mint a
// claim while still anon (it records the anon uid), signInWithOtp, verify the
// code in THIS browser so an in-app browser never has to bounce out to Safari,
// then claim_collect_uploads moves their photos onto the real account. Note it
// is NOT an updateUser() upgrade — the uid changes, which is exactly why the
// claim token has to be minted first.
import { useState, useEffect, useRef } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import { supabase } from "../supabaseClient";
import { MapPin, Users, Image as ImageIcon } from "lucide-react";
import { SIGNED_URL_TTL } from "../lib/photos";
import { realName } from "../lib/names";

// Same public site key as App.js / CollectScreen (bot gate on auth).
const TURNSTILE_SITE_KEY = "0x4AAAAAADTF1P7KXWBPldrU";
const BUCKET = "checkin-photos";
const STRIP = 3; // thumbnails before the "+N" tile

export function GuestHome({ userId, displayName, onSignOut }) {
  // null = loading, [] = none. Own uploads only: activity_photos_select allows
  // `user_id = auth.uid()` regardless of night visibility, so this works even
  // though the guest can't see the album those photos live in.
  const [photos, setPhotos] = useState(null);
  const [total, setTotal] = useState(0);

  const [phase, setPhase] = useState("email"); // "email" | "code"
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [claimToken, setClaimToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [captcha, setCaptcha] = useState(null);
  const captchaRef = useRef(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data: rows, count } = await supabase
        .from("activity_photos")
        .select("id, web_path", { count: "exact" })
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(STRIP);
      if (cancelled) return;
      if (!rows || rows.length === 0) {
        setPhotos([]);
        return;
      }
      setTotal(count ?? rows.length);
      const { data: signed } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(
          rows.map((r) => r.web_path),
          SIGNED_URL_TTL
        );
      if (cancelled) return;
      const byPath = new Map(
        (signed || []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl])
      );
      setPhotos(rows.map((r) => ({ id: r.id, url: byPath.get(r.web_path) || null })));
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function sendCode(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!email.trim() || !captcha || busy) return;
    setBusy(true);
    setErr("");
    try {
      // Mint BEFORE signing in — the RPC records whichever uid is current, and
      // in a moment that won't be the anon one any more. A guest with nothing
      // to carry across is still entitled to an account, so a failed mint is
      // logged and stepped over rather than thrown: no claim, just a sign-up.
      const { data: minted, error: mintErr } = await supabase.rpc(
        "create_collect_claim"
      );
      if (mintErr) console.error("Claim mint failed (continuing):", mintErr);
      else setClaimToken(minted);
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { captchaToken: captcha, shouldCreateUser: true },
      });
      captchaRef.current?.reset();
      setCaptcha(null);
      if (error) throw error;
      setPhase("code");
    } catch (e2) {
      console.error("Guest claim email failed:", e2);
      setErr("Couldn't send the code — try again.");
    }
    setBusy(false);
  }

  async function submitCode(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: "email",
      });
      if (error) throw error;
      await supabase.auth.getSession(); // settle the new JWT before the claim
      if (claimToken) {
        const { error: cErr } = await supabase.rpc("claim_collect_uploads", {
          p_claim: claimToken,
        });
        if (cErr) console.error("Claim reassign failed:", cErr);
      }
      // Name rule v2 (July 31, same as CollectScreen/session gate): ask the
      // profile itself instead of inferring account age — a display_name
      // that's empty, "New user", or the email's local part is the trigger's
      // seed, so the carried name wins. A chosen name is never touched.
      const newUid = data?.user?.id;
      if (displayName && newUid) {
        const { data: fp } = await supabase
          .from("profiles")
          .select("display_name")
          .eq("id", newUid)
          .maybeSingle();
        const localPart = email.trim().split("@")[0].trim().toLowerCase();
        const cur = (fp?.display_name || "").trim().toLowerCase();
        const seeded = !realName(fp?.display_name) || cur === localPart;
        if (seeded) {
          const { error: nErr } = await supabase.rpc("set_guest_name", {
            p_name: displayName,
          });
          if (nErr) console.error("set_guest_name after claim failed:", nErr);
        }
      }
      // Full reload rather than a state flip: App re-mounts against a real
      // session and picks up anything parked for it — a /u/@handle invite in
      // localStorage, ?night=, ?v= — through the effects that already exist.
      window.location.assign("/");
    } catch (e2) {
      console.error("Guest claim code failed:", e2);
      setErr("That code didn't work — check it and try again.");
      setBusy(false);
    }
  }

  const name = (displayName || "").trim();
  const hasPhotos = photos !== null && photos.length > 0;
  const shown = photos || [];
  const extra = Math.max(0, total - shown.length);

  return (
    <div className="min-h-screen bg-[#fdf6f0] text-[#111111]">
      <div className="max-w-sm mx-auto px-4 pt-10 pb-16">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-full bg-[#455d3b] text-white flex items-center justify-center text-base">
            {(name || "?").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            {name && <p className="font-medium truncate">{name}</p>}
            <span className="inline-block mt-0.5 rounded-full bg-[#f0e6dc] px-2 py-0.5 text-xs text-[#6b5f54]">
              Guest
            </span>
          </div>
        </div>

        <h1 className="text-xl font-semibold tracking-tight leading-snug">
          {hasPhotos ? "You're here as a guest" : "Finish setting up to use Flanit"}
        </h1>
        <p className="mt-1 text-sm text-neutral-600 leading-relaxed">
          {hasPhotos
            ? "Your photos are saved to this browser only. Add your email to keep them and see everyone else's."
            : "Guests can add photos to an album they've been sent. The rest needs an account."}
        </p>

        <div className="mt-4 rounded-3xl bg-white p-4 shadow-sm border border-neutral-100">
          {hasPhotos ? (
            <>
              <p className="text-xs text-[#455d3b] mb-2">
                You added {total} photo{total === 1 ? "" : "s"}
              </p>
              <div className="flex gap-1.5 mb-3">
                {shown.map((p) => (
                  <div
                    key={p.id}
                    className="flex-1 aspect-square rounded-lg bg-[#e9e0d5] overflow-hidden"
                  >
                    {p.url && (
                      <img
                        src={p.url}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                ))}
                {extra > 0 && (
                  <div className="flex-1 aspect-square rounded-lg bg-[#edf2eb] flex items-center justify-center text-xs text-[#455d3b]">
                    +{extra}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="mb-3">
              {[
                [MapPin, "Save the places you like"],
                [Users, "See where your friends have been"],
                [ImageIcon, "Keep every photo from the night"],
              ].map(([Icon, label]) => (
                <div
                  key={label}
                  className="flex items-center gap-2.5 py-1.5 text-sm text-neutral-700"
                >
                  <Icon size={17} className="text-[#455d3b] shrink-0" />
                  {label}
                </div>
              ))}
            </div>
          )}

          {phase === "email" && (
            <form onSubmit={sendCode}>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (err) setErr("");
                }}
                placeholder="you@example.com"
                className="w-full rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:border-[#455d3b] focus:outline-none"
              />
              <div className="mt-2 flex justify-center">
                <Turnstile
                  ref={captchaRef}
                  siteKey={TURNSTILE_SITE_KEY}
                  onSuccess={setCaptcha}
                  onExpire={() => setCaptcha(null)}
                  onError={() => setCaptcha(null)}
                  options={{ theme: "light", appearance: "interaction-only" }}
                />
              </div>
              <button
                type="submit"
                disabled={busy || !email.trim() || !captcha}
                className="mt-2 w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy
                  ? "Sending…"
                  : hasPhotos
                    ? "Keep my photos"
                    : "Create my account"}
              </button>
              <p className="mt-2.5 text-center text-xs text-neutral-500 leading-relaxed">
                We'll send a 6-digit code. New or existing account — both work.
              </p>
            </form>
          )}

          {phase === "code" && (
            <form onSubmit={submitCode}>
              <p className="mb-2 text-xs text-neutral-600">
                We sent a code to {email.trim()}.
              </p>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  if (err) setErr("");
                }}
                placeholder="6-digit code"
                className="w-full rounded-full border border-neutral-200 px-4 py-2.5 text-base tracking-widest focus:border-[#455d3b] focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || !code.trim()}
                className="mt-2 w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? "Checking…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhase("email");
                  setCode("");
                  setErr("");
                }}
                className="mt-2 w-full text-center text-xs text-neutral-500 underline underline-offset-2"
              >
                Use a different email
              </button>
            </form>
          )}

          {err && <p className="mt-2 text-center text-xs text-red-600">{err}</p>}
        </div>

        <button
          type="button"
          onClick={onSignOut}
          className="mt-5 w-full text-center text-sm text-[#455d3b] underline underline-offset-2"
        >
          Sign in to a different account
        </button>
      </div>
    </div>
  );
}
