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
import { Camera, Check, UserPlus } from "lucide-react";
import { supabase } from "../supabaseClient";
import { uploadViaCollectLink } from "../lib/photos";
import { sendPush } from "../lib/push";

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
      const nm = prof?.display_name || "";
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
      await supabase
        .from("profiles")
        .upsert({ id: uid, display_name: nm }, { onConflict: "id" });
      setMe({ id: uid, isAnon: true });
      setDisplayName(nm);
      setNeedsDoor(false);
    } catch (e) {
      console.error("Collect door failed:", e);
      setDoorError("That didn't work — try again.");
    }
    setEntering(false);
  }

  // Signed-in friend after a successful upload: the silent twin — their own
  // check-in joined into the night (Been + avatar row), no photo split.
  async function ensureFriendTwin() {
    if (twinDone || !me || me.isAnon || relation !== "friend" || !ctx) return;
    setTwinDone(true);
    try {
      const t = new Date(ctx.checked_in_at).getTime();
      const lo = new Date(t - 12 * 3600e3).toISOString();
      const hi = new Date(t + 12 * 3600e3).toISOString();
      let q = supabase
        .from("activities")
        .select("id")
        .eq("user_id", me.id)
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
            user_id: me.id,
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
      console.error("Friend twin failed (photos are safe):", e);
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
      sendPush(
        ctx.owner_id,
        "📸 New photos on your night",
        `${displayName || "Someone"} added ${landed} ${
          landed === 1 ? "photo" : "photos"
        } at ${ctx.venue_name}`
      );
      ensureFriendTwin();
    }
  }

  async function addOwnerAsFriend() {
    if (!me || me.isAnon || !ctx) return;
    setRelation("pending");
    const { error } = await supabase.from("friendships").insert({
      requester_id: me.id,
      addressee_id: ctx.owner_id,
      status: "pending",
    });
    if (error && error.code !== "23505") setRelation("none");
    else
      sendPush(
        ctx.owner_id,
        "New friend request",
        `${displayName || "Someone"} from your night wants to add you`
      );
  }

  const landedCount = uploads.filter((u) => u.url).length;

  // ---------- render ----------
  if (ctx === undefined) {
    return (
      <div className="min-h-screen bg-[#fdf6f0] flex items-center justify-center">
        <p className="text-sm text-neutral-500">Opening the night…</p>
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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight leading-snug">
          Add your photos to {ctx.owner_name}'s night
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          {ctx.label ? `${ctx.label} · ` : ""}
          {ctx.venue_name} · {niceDate(ctx.checked_in_at)}
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
                  {landedCount === 1 ? "Photo added" : `${landedCount} added`} to{" "}
                  {ctx.owner_name}'s night
                </p>
                {me.isAnon && (
                  <>
                    <p className="mt-2 text-xs text-neutral-500">
                      Want to see everyone's photos from the night? Get Flanit
                      and add {ctx.owner_name} as a friend.
                    </p>
                    <a
                      href="/install"
                      className="mt-3 inline-block rounded-full bg-[#455d3b] px-5 py-2.5 text-sm font-medium text-white"
                    >
                      Get Flanit
                    </a>
                  </>
                )}
                {!me.isAnon && relation === "friend" && (
                  <>
                    <p className="mt-2 text-xs text-neutral-500">
                      Added to the night — it's in your Been too.
                    </p>
                    <a
                      href="/"
                      className="mt-3 inline-block rounded-full bg-[#455d3b] px-5 py-2.5 text-sm font-medium text-white"
                    >
                      View the night in Flanit
                    </a>
                  </>
                )}
                {!me.isAnon && (relation === "none" || relation === "pending") && (
                  <>
                    <p className="mt-2 text-xs text-neutral-500">
                      Add {ctx.owner_name} as a friend to see the whole night.
                    </p>
                    <button
                      type="button"
                      disabled={relation === "pending"}
                      onClick={addOwnerAsFriend}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#455d3b] px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60"
                    >
                      <UserPlus size={14} />
                      {relation === "pending"
                        ? "Requested ✓"
                        : `Add ${ctx.owner_name}`}
                    </button>
                  </>
                )}
                {!me.isAnon && relation === "self" && (
                  <p className="mt-2 text-xs text-neutral-500">
                    This is your own link — open Flanit to see the night.
                  </p>
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
