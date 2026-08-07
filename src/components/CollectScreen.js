// COLLECT LINK landing — flanit.co/c/<token> (July 24, 2026; design settled
// July 23, see 08-ideas.md). One shared link per check-in; anyone holding it
// can add photos to the night. Doctrine:
//   * The browser answers the identity question. Existing Flanit session →
//     arrive as yourself, no login moment. No session → anonymous auth with
//     a "Who's this?" name door, asked ONCE per device (the anon session +
//     profiles.display_name persist in localStorage).
//   * Via-link uploads attach to the LINK OWNER's activity — uploading here
//     is consent to the ALBUM's audience. Guests only ever see their OWN
//     thumbnails on this page (never the album — link ≠ friendship).
//   * Signed-in FRIEND: two consents (their upload, owner's link) → a
//     same-night twin check-in lands silently in their Been, joined into
//     the night graph. Non-friend: photos land + an Add-friend offer.
//   * Every upload batch pushes the owner ("X added N photos to your night").
import { useState, useEffect, useRef } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import { Camera, Check } from "lucide-react";
import { supabase } from "../supabaseClient";
import { uploadViaCollectLink } from "../lib/photos";
import { sendPush } from "../lib/push";
import { realName } from "../lib/names";

// Same public site key as App.js (bot gate on anonymous auth).
const TURNSTILE_SITE_KEY = "0x4AAAAAADTF1P7KXWBPldrU";
const GUEST_CAP = 10;

function niceDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

export function CollectScreen({ token }) {
  // link context (undefined = loading, null = revoked/unknown)
  const [ctx, setCtx] = useState(undefined);
  // auth: undefined = checking, null = none yet, else { id, isAnon }
  const [me, setMe] = useState(undefined);
  const [displayName, setDisplayName] = useState("");
  const [needsDoor, setNeedsDoor] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [captchaToken, setCaptchaToken] = useState(null);
  const captchaRef = useRef(null);
  const [entering, setEntering] = useState(false);
  const [doorError, setDoorError] = useState("");
  // uploads on THIS device for THIS link (confirmation strip)
  const [uploads, setUploads] = useState([]); // {key,url,progress,error,kind}
  const [uploading, setUploading] = useState(false);
  // relationship to the owner, real accounts only:
  // null=unknown, "self", "friend", "pending", "none"
  const [relation, setRelation] = useState(null);
  const [twinDone, setTwinDone] = useState(false);
  const fileRef = useRef(null);

  // Resolve the link (anon-callable) + settle auth, in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [linkRes, sessRes] = await Promise.all([
        supabase.rpc("resolve_collect_link", { p_token: token }),
        supabase.auth.getSession(),
      ]);
      if (cancelled) return;
      const row = linkRes.data?.[0] || null;
      setCtx(row);
      const session = sessRes.data?.session || null;
      if (!session) {
        setMe(null);
        setNeedsDoor(true);
        return;
      }
      const isAnon = !!session.user.is_anonymous;
      setMe({ id: session.user.id, isAnon });
      const { data: prof } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", session.user.id)
        .maybeSingle();
      if (cancelled) return;
      // realName: the handle_new_user trigger seeds anons with "New user",
      // which is a placeholder, not a remembered name — it must not skip the
      // door or the page would greet them "Uploading as New user" (July 31).
      const nm = realName(prof?.display_name) || "";
      setDisplayName(nm);
      // Anon with no remembered name still gets the door (no captcha —
      // the session already exists, it's just a name update).
      setNeedsDoor(isAnon && !nm);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Real signed-in users: where do they stand with the owner?
  useEffect(() => {
    if (!me || me.isAnon || !ctx?.owner_id) return;
    if (me.id === ctx.owner_id) {
      setRelation("self");
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id, status")
        .or(`requester_id.eq.${me.id},addressee_id.eq.${me.id}`);
      if (cancelled) return;
      const rel = (rows || []).find(
        (r) =>
          r.requester_id === ctx.owner_id || r.addressee_id === ctx.owner_id
      );
      setRelation(
        rel?.status === "accepted"
          ? "friend"
          : rel?.status === "pending"
          ? "pending"
          : "none"
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [me, ctx?.owner_id]);

  async function enter() {
    const nm = nameDraft.trim();
    if (!nm) return;
    setEntering(true);
    setDoorError("");
    try {
      let uid = me?.id;
      if (!uid) {
        if (!captchaToken) {
          setEntering(false);
          return;
        }
        const { data, error } = await supabase.auth.signInAnonymously({
          options: { captchaToken },
        });
        captchaRef.current?.reset();
        setCaptchaToken(null);
        if (error) throw error;
        uid = data?.user?.id;
        // Settle the JWT before the profile write (RLS reads auth.uid()).
        await supabase.auth.getSession();
      }
      if (!uid) throw new Error("no user");
      // SECURITY DEFINER — the old client-side upsert could fail silently
      // under RLS and leave a stale name ("New", July 25 field test).
      const { error: nameErr } = await supabase.rpc("set_guest_name", {
        p_name: nm,
      });
      if (nameErr) throw nameErr;
      setMe({ id: uid, isAnon: true });
      setDisplayName(nm);
      setNeedsDoor(false);
    } catch (e) {
      console.error("Collect door failed:", e);
      setDoorError("That didn't work — try again.");
    }
    setEntering(false);
  }

  // Any signed-in account that came through the link is IN the night — the
  // link was the owner's invitation, uploading/signing in is the consent
  // (July 25, Mark: "they should be added to the event"). Friend or not:
  // the twin + joined_from edge makes them a participant (night graph v2
  // shows participants each other's shards), lands the night in their Been,
  // and puts them on the card's avatar row.
  async function ensureNightTwin(uid) {
    if (twinDone || !uid || !ctx || uid === ctx.owner_id) return;
    setTwinDone(true);
    try {
      const t = new Date(ctx.checked_in_at).getTime();
      const lo = new Date(t - 12 * 3600e3).toISOString();
      const hi = new Date(t + 12 * 3600e3).toISOString();
      let q = supabase
        .from("activities")
        .select("id")
        .eq("user_id", uid)
        .gte("created_at", lo)
        .lte("created_at", hi)
        .limit(1);
      q = ctx.venue_id
        ? q.eq("venue_id", ctx.venue_id)
        : q.eq("joined_from", ctx.activity_id);
      const { data: existing } = await q;
      let twinId = existing?.[0]?.id;
      if (!twinId) {
        const { data: ins } = await supabase
          .from("activities")
          .insert({
            user_id: uid,
            venue_id: ctx.venue_id,
            kind: "checkin",
            created_at: ctx.checked_in_at,
            joined_from: ctx.activity_id,
          })
          .select("id")
          .single();
        twinId = ins?.id;
      }
      if (twinId) {
        // My shard says "with [owner]" — my own activity, my tag to write.
        // Best-effort: tag RLS is friends-only, so this may no-op for
        // non-friends; the joined_from edge alone carries participation.
        await supabase.from("activity_tags").upsert(
          {
            activity_id: twinId,
            tagged_user_id: ctx.owner_id,
            status: "accepted",
            responded_at: new Date().toISOString(),
          },
          { onConflict: "activity_id,tagged_user_id", ignoreDuplicates: true }
        );
      }
    } catch (e) {
      console.error("Night twin failed (photos are safe):", e);
    }
  }

  async function pickFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0 || !me || !ctx) return;
    const room = GUEST_CAP - uploads.filter((u) => !u.error).length;
    const batch = files.slice(0, Math.max(0, room));
    if (batch.length === 0) return;
    setUploading(true);
    let landed = 0;
    for (const file of batch) {
      const key = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      setUploads((prev) => [...prev, { key, url: null, progress: 0, kind: "photo" }]);
      try {
        const row = await uploadViaCollectLink(
          me.id,
          token,
          ctx.activity_id,
          file,
          (pct) =>
            setUploads((prev) =>
              prev.map((u) => (u.key === key ? { ...u, progress: pct } : u))
            )
        );
        landed += 1;
        setUploads((prev) =>
          prev.map((u) =>
            u.key === key ? { ...u, url: row.url, kind: row.kind, progress: 100 } : u
          )
        );
      } catch (e) {
        console.error("Via-link upload failed:", e);
        const msg = /link_inactive/.test(e?.message || "")
          ? "Link no longer active"
          : /guest_cap|link_cap/.test(e?.message || "")
          ? "Upload limit reached"
          : "Failed — tap to retry later";
        setUploads((prev) =>
          prev.map((u) => (u.key === key ? { ...u, error: msg } : u))
        );
      }
    }
    setUploading(false);
    if (landed > 0) {
      // Fan the push out to EVERYONE in the night (July 25, Mark: "notify
      // all people on the album"), not just the link owner.
      const body = `${displayName || "Someone"} added ${landed} ${
        landed === 1 ? "photo" : "photos"
      } at ${ctx.venue_name}`;
      try {
        const { data: recips } = await supabase.rpc("collect_recipients", {
          p_token: token,
        });
        const targets =
          recips && recips.length > 0
            ? recips.filter((uid) => uid !== me.id)
            : [ctx.owner_id];
        for (const uid of targets) {
          sendPush(uid, "📸 New photos", body);
        }
      } catch {
        sendPush(ctx.owner_id, "📸 New photos", body);
      }
      if (me && !me.isAnon) ensureNightTwin(me.id);
    }
  }

  // CLAIM FLOW (July 25 — Mark: "Get Flanit goes to install, not sign up").
  // Email-code sign-in ON this page. The claim token is minted while STILL
  // anon (it records the anon uid); after verifyOtp swaps the session to the
  // real account, claim_collect_uploads() moves the uploads across. Works
  // for brand-new accounts AND forgotten ones (signInWithOtp signs into the
  // existing account when the email is known).
  const [claimPhase, setClaimPhase] = useState(null); // null | "email" | "code"
  const [claimEmail, setClaimEmail] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [claimToken, setClaimToken] = useState(null);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimErr, setClaimErr] = useState("");
  const [claimCaptcha, setClaimCaptcha] = useState(null);
  const claimCaptchaRef = useRef(null);

  async function startClaimEmail() {
    if (!claimEmail.trim() || !claimCaptcha || claimBusy) return;
    setClaimBusy(true);
    setClaimErr("");
    try {
      const { data: minted, error: mintErr } = await supabase.rpc(
        "create_collect_claim"
      );
      if (mintErr) throw mintErr;
      setClaimToken(minted);
      const { error } = await supabase.auth.signInWithOtp({
        email: claimEmail.trim(),
        options: { captchaToken: claimCaptcha, shouldCreateUser: true },
      });
      claimCaptchaRef.current?.reset();
      setClaimCaptcha(null);
      if (error) throw error;
      setClaimPhase("code");
    } catch (e) {
      console.error("Claim email failed:", e);
      setClaimErr("Couldn't send the code — try again.");
    }
    setClaimBusy(false);
  }

  async function submitClaimCode() {
    if (!claimCode.trim() || claimBusy) return;
    setClaimBusy(true);
    setClaimErr("");
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: claimEmail.trim(),
        token: claimCode.trim(),
        type: "email",
      });
      if (error) throw error;
      const uid = data?.user?.id;
      if (!uid) throw new Error("no user");
      await supabase.auth.getSession(); // settle the new JWT
      if (claimToken) {
        const { error: cErr } = await supabase.rpc("claim_collect_uploads", {
          p_claim: claimToken,
        });
        if (cErr) console.error("Claim reassign failed:", cErr);
      }
      // Name rule (Mark, July 25 — "Flynn" became "mark+event"): the
      // signup trigger seeds display_name from the EMAIL local part, so
      // "only if empty" never fired. Instead: BRAND-NEW account (created
      // by this very code-send) → the door name wins. Existing account →
      // never touched, whatever they have is theirs.
      const isNewAccount =
        data?.user?.created_at &&
        Date.now() - new Date(data.user.created_at).getTime() <
          10 * 60 * 1000;
      if (displayName && isNewAccount) {
        await supabase.rpc("set_guest_name", { p_name: displayName });
      }
      // They're in the night now: twin check-in (Been + avatar row) and a
      // "joined" push to everyone already on the album.
      await ensureNightTwin(uid);
      const joinedCount = uploads.filter((u) => u.url).length;
      try {
        const { data: recips } = await supabase.rpc("collect_recipients", {
          p_token: token,
        });
        const nm = displayName || "Someone";
        const body = joinedCount
          ? `${nm} is in — with ${joinedCount} ${
              joinedCount === 1 ? "photo" : "photos"
            } from ${ctx.venue_name}`
          : `${nm} is in at ${ctx.venue_name}`;
        for (const r of recips || []) {
          if (r !== uid) sendPush(r, "🎉 They joined the photos", body);
        }
      } catch {}
      // Straight through to the photos (Mark, July 25: no gate ceremony):
      // the app shows onboarding first for brand-new accounts, then opens
      // the card with the album loaded. Brief pause so the joined pushes
      // aren't cancelled by the navigation.
      setClaimBusy(false);
      await new Promise((r) => setTimeout(r, 400));
      window.location.href = `/?night=${ctx.activity_id}`;
      return;
    } catch (e) {
      console.error("Claim code failed:", e);
      setClaimErr("That code didn't work — check it and try again.");
    }
    setClaimBusy(false);
  }

  // (Add-owner-as-friend moved to the check-in card's banner — the landing
  // stays single-purpose: photos in, photos seen.)

  const landedCount = uploads.filter((u) => u.url).length;

  // ---------- render ----------
  if (ctx === undefined) {
    return (
      <div className="min-h-screen bg-[#fdf6f0] flex items-center justify-center">
        <p className="text-sm text-neutral-500">Opening…</p>
      </div>
    );
  }
  if (ctx === null) {
    return (
      <div className="min-h-screen bg-[#fdf6f0] flex items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-sm border border-neutral-100">
          <p className="text-lg font-semibold">This link is no longer active</p>
          <p className="mt-2 text-sm text-neutral-600">
            Ask whoever sent it for a fresh one.
          </p>
          <a
            href="/install"
            className="mt-5 inline-block rounded-full bg-[#455d3b] px-5 py-2.5 text-sm font-medium text-white"
          >
            Get Flanit
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fdf6f0] text-[#111111]">
      <div className="mx-auto w-full max-w-sm px-4 pb-16 pt-10">
        {/* Context header — whose night, where, when. Never the album. */}
        <p className="text-xs font-semibold uppercase tracking-wide text-[#455d3b]">
          Flanit
        </p>
        {/* Event name leads when there is one; the venue is the fallback
            (Mark, July 25: "the main CTA should be centered around the
            event name"). */}
        <h1 className="mt-2 text-2xl font-semibold tracking-tight leading-snug">
          Add your photos from {ctx.label || ctx.venue_name}
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          {ctx.owner_name} is collecting everyone's photos
          {ctx.label ? ` · ${ctx.venue_name}` : ""} · {niceDate(ctx.checked_in_at)}
        </p>

        {/* Name door — once per device, skipped for known browsers. */}
        {needsDoor && (
          <div className="mt-6 rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <p className="text-sm font-medium">Who's this?</p>
            <p className="mt-1 text-xs text-neutral-500">
              Your name goes on your photos — that's it. No account needed.
            </p>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && enter()}
              placeholder="Your name"
              maxLength={40}
              className="mt-3 w-full rounded-2xl bg-neutral-50 px-4 py-3.5 text-base outline-none border border-neutral-100 focus:border-[#455d3b]"
            />
            {!me && (
              <div className="mt-3 flex justify-center">
                <Turnstile
                  ref={captchaRef}
                  siteKey={TURNSTILE_SITE_KEY}
                  onSuccess={setCaptchaToken}
                  onExpire={() => setCaptchaToken(null)}
                  onError={() => setCaptchaToken(null)}
                  options={{ theme: "light", appearance: "interaction-only" }}
                />
              </div>
            )}
            <button
              type="button"
              disabled={entering || !nameDraft.trim() || (!me && !captchaToken)}
              onClick={enter}
              className="mt-3 w-full rounded-2xl bg-[#455d3b] py-3.5 font-medium text-white disabled:bg-neutral-300 active:scale-[0.99] transition"
            >
              {entering ? "One sec…" : "Continue"}
            </button>
            {doorError && (
              <p className="mt-2 text-sm text-red-600">{doorError}</p>
            )}
          </div>
        )}

        {/* Picker + confirmation strip */}
        {!needsDoor && me && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                pickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploading || landedCount >= GUEST_CAP}
              onClick={() => fileRef.current?.click()}
              className="mt-6 flex w-full flex-col items-center gap-2 rounded-3xl border-2 border-dashed border-[#455d3b]/40 bg-white/60 py-10 text-[#455d3b] active:scale-[0.99] transition disabled:opacity-50"
            >
              <Camera size={28} />
              <span className="text-sm font-medium">
                {landedCount === 0 ? "Add photos or videos" : "Add more"}
              </span>
              <span className="text-[11px] text-neutral-500">
                {displayName ? `Uploading as ${displayName} · ` : ""}up to {GUEST_CAP}
              </span>
            </button>

            {uploads.length > 0 && (
              <div className="mt-4 grid grid-cols-3 gap-1.5">
                {uploads.map((u) => (
                  <div key={u.key} className="relative aspect-square">
                    {u.url ? (
                      <img
                        src={u.url}
                        alt=""
                        className="h-full w-full rounded-lg object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center rounded-lg bg-neutral-200">
                        <span className="text-[10px] font-medium text-neutral-600 px-1 text-center">
                          {u.error
                            ? u.error
                            : u.progress
                            ? `${u.progress}%`
                            : "Uploading…"}
                        </span>
                      </div>
                    )}
                    {u.kind === "video" && u.url && (
                      <span className="absolute inset-0 flex items-center justify-center">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-xs text-white">
                          ▶
                        </span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Per-population exit */}
            {landedCount > 0 && (
              <div className="mt-6 rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#edf2eb] text-[#455d3b]">
                    <Check size={14} />
                  </span>
                  {landedCount === 1
                    ? "Photo added"
                    : `${landedCount} photos added`}
                </p>
                {me.isAnon && claimPhase === null && (
                  <>
                    <button
                      type="button"
                      onClick={() => setClaimPhase("email")}
                      className="mt-3 inline-block rounded-full bg-[#455d3b] px-5 py-2.5 text-sm font-medium text-white active:scale-95 transition"
                    >
                      See all the photos
                    </button>
                    <a
                      href="/install"
                      className="ml-3 text-xs font-medium text-neutral-500 underline underline-offset-2"
                    >
                      or get the app
                    </a>
                  </>
                )}
                {me.isAnon && claimPhase === "email" && (
                  <div className="mt-3">
                    <p className="text-xs text-neutral-500">
                      Your email gets you in — we'll send a code. Your photos
                      come with you.
                    </p>
                    <input
                      type="email"
                      value={claimEmail}
                      onChange={(e) => setClaimEmail(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && startClaimEmail()}
                      placeholder="you@email.com"
                      className="mt-2 w-full rounded-2xl bg-neutral-50 px-4 py-3.5 text-base outline-none border border-neutral-100 focus:border-[#455d3b]"
                    />
                    <div className="mt-2 flex justify-center">
                      <Turnstile
                        ref={claimCaptchaRef}
                        siteKey={TURNSTILE_SITE_KEY}
                        onSuccess={setClaimCaptcha}
                        onExpire={() => setClaimCaptcha(null)}
                        onError={() => setClaimCaptcha(null)}
                        options={{
                          theme: "light",
                          appearance: "interaction-only",
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={
                        claimBusy || !claimEmail.trim() || !claimCaptcha
                      }
                      onClick={startClaimEmail}
                      className="mt-2 w-full rounded-full bg-[#455d3b] py-2.5 text-sm font-medium text-white disabled:bg-neutral-300 active:scale-[0.99] transition"
                    >
                      {claimBusy ? "Sending…" : "Email me a code"}
                    </button>
                    {claimErr && (
                      <p className="mt-2 text-xs text-red-600">{claimErr}</p>
                    )}
                  </div>
                )}
                {me.isAnon && claimPhase === "code" && (
                  <div className="mt-3">
                    <p className="text-xs text-neutral-500">
                      We emailed a 6-digit code to {claimEmail.trim()}.
                    </p>
                    <input
                      inputMode="numeric"
                      value={claimCode}
                      onChange={(e) => setClaimCode(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && submitClaimCode()}
                      placeholder="123456"
                      maxLength={6}
                      className="mt-2 w-full rounded-2xl bg-neutral-50 px-4 py-3.5 text-base tracking-widest outline-none border border-neutral-100 focus:border-[#455d3b]"
                    />
                    <button
                      type="button"
                      disabled={claimBusy || !claimCode.trim()}
                      onClick={submitClaimCode}
                      className="mt-2 w-full rounded-full bg-[#455d3b] py-2.5 text-sm font-medium text-white disabled:bg-neutral-300 active:scale-[0.99] transition"
                    >
                      {claimBusy ? "One sec…" : "See the photos"}
                    </button>
                    {claimErr && (
                      <p className="mt-2 text-xs text-red-600">{claimErr}</p>
                    )}
                  </div>
                )}
                {!me.isAnon && relation === "friend" && (
                  <>
                    <p className="mt-2 text-xs text-neutral-500">
                      You're in — this one's in your Been too.
                    </p>
                    <a
                      href={`/?night=${ctx.activity_id}`}
                      className="mt-3 inline-block rounded-full bg-[#455d3b] px-5 py-2.5 text-sm font-medium text-white"
                    >
                      See all the photos
                    </a>
                  </>
                )}
                {!me.isAnon && (relation === "none" || relation === "pending") && (
                  <>
                    {/* Same exit as friends — the Add-[owner] ask lives on
                        the check-in card itself (the banner), not here. */}
                    <p className="mt-2 text-xs text-neutral-500">
                      You're in — this one's in your Been too.
                    </p>
                    <a
                      href={`/?night=${ctx.activity_id}`}
                      className="mt-3 inline-block rounded-full bg-[#455d3b] px-5 py-2.5 text-sm font-medium text-white"
                    >
                      See all the photos
                    </a>
                  </>
                )}
                {!me.isAnon && relation === "self" && (
                  <>
                    <p className="mt-2 text-xs text-neutral-500">
                      This is your own link.
                    </p>
                    <a
                      href={`/?night=${ctx.activity_id}`}
                      className="mt-3 inline-block rounded-full bg-[#455d3b] px-5 py-2.5 text-sm font-medium text-white"
                    >
                      See all the photos
                    </a>
                  </>
                )}
              </div>
            )}
          </>
        )}

        <p className="mt-8 text-center text-[11px] text-neutral-400">
          Photos are only visible to {ctx.owner_name}'s friends on Flanit.
        </p>
      </div>
    </div>
  );
}
