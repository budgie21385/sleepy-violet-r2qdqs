// ORGANISER LANDING — flanit.co/weddings + flanit.co/events (Aug 30, 2026).
// The July doctrine come home: the landing page frames the job BEFORE the
// CTA, so the source tells us the intent — /weddings arrivals are wedding
// organisers by construction (Say I Do links here), /events wears the
// generic skin. Functional now, design pass later (Mark).
//
// THREE EXPLICIT AUTH STATES (Mark: "the first screen doesn't take into
// account a sign in" — implicit magic isn't an affordance):
//   * real session in this browser → welcome-back card, straight to the form
//   * no session / anon session → email-code card, with a visible
//     "Already on Flanit? Sign in" link that swaps the card's FRAMING
//     (same OTP flow underneath — creates new accounts, signs in old ones;
//     an anon's prior uploads ride along via the claim machinery upstream)
//   * after the code: intent flag → app → profile onboarding if new →
//     the event form opens itself, once.
// Brevo upsert happens AFTER auth succeeds (bearer-verified server-side),
// so the contact list can't be spammed by hitting the endpoint raw.
import { useState, useEffect, useRef } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import { supabase } from "../supabaseClient";
import { realName } from "../lib/names";

const TURNSTILE_SITE_KEY = "0x4AAAAAADTF1P7KXWBPldrU";
export const CREATE_EVENT_INTENT_KEY = "flanit_create_event_intent";

const COPY = {
  weddings: {
    hero: "Every guest's wedding photos. One album.",
    sub: "Create your wedding on Flanit and the album is ready before the day. Guests add photos with a link or QR code — no app, no sign-up needed.",
    steps: [
      "Create your wedding — takes two minutes",
      "Share the link, or print the QR for the tables",
      "Every photo lands in one album, yours to keep",
    ],
    cta: "Create your wedding album — free",
  },
  events: {
    hero: "One link. Every guest's photos.",
    sub: "Create your event and the album is ready before the night. Guests add photos with a link or QR — no app needed.",
    steps: [
      "Create your event — takes two minutes",
      "Share the link, or print the QR",
      "Every photo lands in one album",
    ],
    cta: "Create your event — free",
  },
};

async function brevoUpsert(source, extra = {}) {
  // Fire-and-forget; the funnel never blocks on marketing plumbing.
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return;
    await fetch("/api/brevo-contact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source, ...extra }),
    });
  } catch {}
}

export function EventsLanding({ variant = "events" }) {
  const copy = COPY[variant] || COPY.events;
  // undefined = checking, null = none/anon, else { id, name }
  const [me, setMe] = useState(undefined);
  const [mode, setMode] = useState("create"); // "create" | "signin" — framing only
  const [phase, setPhase] = useState(null); // null | "code"
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [captcha, setCaptcha] = useState(null);
  const captchaRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data?.session?.user;
      if (!user || user.is_anonymous) {
        if (!cancelled) setMe(null);
        return;
      }
      const { data: prof } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .maybeSingle();
      if (!cancelled)
        setMe({
          id: user.id,
          name: realName(prof?.display_name) ? prof.display_name : "there",
        });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function goCreate() {
    try {
      localStorage.setItem(CREATE_EVENT_INTENT_KEY, "1");
    } catch {}
    window.location.href = "/";
  }

  async function sendCode() {
    if (!email.trim() || !captcha || busy) return;
    setBusy(true);
    setErr("");
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { captchaToken: captcha, shouldCreateUser: true },
      });
      captchaRef.current?.reset();
      setCaptcha(null);
      if (error) throw error;
      setPhase("code");
    } catch (e) {
      console.error("Landing OTP failed:", e);
      setErr("Couldn't send the code — try again.");
    }
    setBusy(false);
  }

  async function submitCode() {
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
      if (!data?.user?.id) throw new Error("no user");
      await supabase.auth.getSession(); // settle the new JWT
      await brevoUpsert(variant);
      goCreate();
    } catch (e) {
      console.error("Landing code failed:", e);
      setErr("That code didn't work — check it and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#fdf6f0]">
      <div className="mx-auto w-full max-w-sm px-5 py-10">
        <p className="text-sm font-semibold text-[#455d3b] mb-8">Flanit</p>
        <h1 className="text-3xl font-semibold tracking-tight leading-tight">
          {copy.hero}
        </h1>
        <p className="mt-3 text-sm text-neutral-600">{copy.sub}</p>

        <div className="mt-6 space-y-2.5">
          {copy.steps.map((s, i) => (
            <div key={s} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#edf2eb] text-xs font-semibold text-[#455d3b]">
                {i + 1}
              </span>
              <p className="text-sm text-neutral-800">{s}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
          {me === undefined ? (
            <p className="text-sm text-neutral-500 text-center py-2">…</p>
          ) : me ? (
            <>
              <p className="text-sm text-neutral-800 mb-3">
                Welcome back, <strong className="font-medium">{me.name}</strong>
              </p>
              <button
                type="button"
                onClick={async () => {
                  await brevoUpsert(variant);
                  goCreate();
                }}
                className="w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white active:scale-[0.99] transition"
              >
                {variant === "weddings" ? "Create your wedding" : "Create your event"}
              </button>
              <button
                type="button"
                onClick={async () => {
                  await supabase.auth.signOut();
                  window.location.reload();
                }}
                className="mt-2 w-full text-center text-xs text-neutral-500 underline underline-offset-2"
              >
                Not you? Sign out
              </button>
            </>
          ) : phase === null ? (
            <>
              <p className="text-sm font-medium">
                {mode === "create" ? copy.cta : "Sign in to Flanit"}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {mode === "create"
                  ? "Your email gets you started — we'll send a code."
                  : "We'll email you a code. This lands in your Events tab everywhere you're signed in."}
              </p>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendCode()}
                placeholder="you@email.com"
                className="mt-3 w-full rounded-2xl bg-neutral-50 px-4 py-3.5 text-base outline-none border border-neutral-100 focus:border-[#455d3b]"
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
                type="button"
                disabled={busy || !email.trim() || !captcha}
                onClick={sendCode}
                className="mt-2 w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white disabled:bg-neutral-300 active:scale-[0.99] transition"
              >
                {busy ? "Sending…" : "Email me a code"}
              </button>
              {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
              <button
                type="button"
                onClick={() => setMode(mode === "create" ? "signin" : "create")}
                className="mt-3 w-full text-center text-xs text-[#455d3b] underline underline-offset-2"
              >
                {mode === "create"
                  ? "Already on Flanit? Sign in"
                  : "New here? Create your account"}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">Check your email</p>
              <p className="mt-1 text-xs text-neutral-500">
                We sent a 6-digit code to {email.trim()}.
              </p>
              <input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitCode()}
                placeholder="123456"
                maxLength={6}
                className="mt-3 w-full rounded-2xl bg-neutral-50 px-4 py-3.5 text-base tracking-widest outline-none border border-neutral-100 focus:border-[#455d3b]"
              />
              <button
                type="button"
                disabled={busy || !code.trim()}
                onClick={submitCode}
                className="mt-2 w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white disabled:bg-neutral-300 active:scale-[0.99] transition"
              >
                {busy ? "Checking…" : "Continue"}
              </button>
              {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
              <button
                type="button"
                onClick={() => {
                  setPhase(null);
                  setCode("");
                  setErr("");
                }}
                className="mt-3 w-full text-center text-xs text-neutral-500 underline underline-offset-2"
              >
                Different email
              </button>
            </>
          )}
        </div>

        <p className="mt-6 text-[11px] text-neutral-400">
          Free for organisers and guests. Photos stay private to the event.
        </p>
      </div>
    </div>
  );
}
