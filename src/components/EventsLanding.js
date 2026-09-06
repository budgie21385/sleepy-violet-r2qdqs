// ORGANISER LANDING — flanit.co/weddings + flanit.co/events.
// Aug 30: functional page (three explicit auth states, OTP signup, Brevo
// upsert, create-event intent). Sep 6: the DESIGN PASS landed (Mark's
// Claude-Design mock, implemented here): Lora serif headlines over the app
// sans, cream/olive/sage bands, phone + table-card + chat mockups, FAQ,
// one CTA repeated. /weddings wears the wedding skin (Say I Do links here,
// intent by construction); /events the generic one. The signup card's
// MACHINERY is unchanged from Aug 30 — same states, same OTP, same captcha:
//   * real session in this browser → welcome-back card
//   * no session / anon → email-code card with a "Sign in" framing swap
//   * after the code: intent flag → app → onboarding → event form opens once
// Brevo upsert happens AFTER auth succeeds (bearer-verified server-side).
// Photo slots render as tinted placeholders until real candids exist.
import { useState, useEffect, useRef } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import {
  ImagePlus,
  QrCode,
  Sparkles,
  Download,
  Lock,
  Eye,
} from "lucide-react";
import { supabase } from "../supabaseClient";
import { realName } from "../lib/names";

const TURNSTILE_SITE_KEY = "0x4AAAAAADTF1P7KXWBPldrU";
export const CREATE_EVENT_INTENT_KEY = "flanit_create_event_intent";

const SERIF = { fontFamily: "'Lora', Georgia, serif" };

const COPY = {
  weddings: {
    hero: "Every guest's wedding photos. One album.",
    sub: "Guests add photos with a link or QR code. No app, no sign-up needed.",
    cta: "Create your wedding album, free",
    steps: [
      "Create your wedding album",
      "Share the link or print the QR for the tables",
      "Every photo lands in one album, live on the night",
    ],
    mockName: "Ruth & Sam",
    mockMeta: "142 photos · 38 people adding",
    mockLink: "flanit.co/ruthandsam",
    wedgeTitle: "The photos you'd never see.",
    wedgeSub:
      "The photographer gets the ceremony. Guests get everything else: getting ready, the kids' table, the dance floor at 11pm.",
    tableSub: "Guests add photos between courses. We give you the card ready to print.",
    afterTitle: "Send a link after the wedding.",
    afterSub:
      "Half your guests won't get round to it on the night. Send the album the next morning and it keeps filling for weeks, camera rolls and all.",
    chatMsg:
      "Thank you for Saturday, all of you. Here's every photo anyone took, and please add yours.",
    chatReply: "Just put in 40 from the dance floor. Sorry about most of them.",
    fiveAlbums: true,
    faqShare:
      "Most couples send it with the invitations and put the QR card out on the tables. Anything added before the day just goes in early.",
    cardTitle: "Create your wedding album",
  },
  events: {
    hero: "One link. Every guest's photos.",
    sub: "Guests add photos with a link or QR code. No app, no sign-up needed.",
    cta: "Create your event album, free",
    steps: [
      "Create your event album",
      "Share the link or print the QR",
      "Every photo lands in one album, live on the night",
    ],
    mockName: "Sam's 30th",
    mockMeta: "86 photos · 19 people adding",
    mockLink: "flanit.co/sams30th",
    wedgeTitle: "The photos that get lost.",
    wedgeSub:
      "Everyone takes photos. They stay on twenty phones and nobody ever sees them. One link fixes that.",
    tableSub: "Birthdays, dinners, farewells. Print the QR and guests scan it.",
    afterTitle: "Send the link the morning after.",
    afterSub:
      "Half your guests won't get round to it on the night. Send the album the next day and it keeps filling, camera rolls and all.",
    chatMsg:
      "Thanks for last night everyone. Here's every photo anyone took, and please add yours.",
    chatReply: "Just added mine. Some absolute gold in there.",
    fiveAlbums: false,
    faqShare:
      "Most people send it with the invite and share the QR on the night. Anything added before the day just goes in early.",
    cardTitle: "Create your event album",
  },
};

// A fixed 7x7 pattern that reads as a QR at small sizes.
const QR = "1110111100101010111011000000101101110101100110111010".slice(0, 49);

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

function Placeholder({ h, tint, caption, className = "" }) {
  return (
    <div
      className={`relative overflow-hidden rounded-[20px] ${className}`}
      style={{ height: h, background: tint }}
    >
      {caption && (
        <span className="absolute bottom-2 left-2.5 rounded-full bg-black/25 px-2 py-0.5 text-[10px] text-white/90">
          {caption}
        </span>
      )}
    </div>
  );
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

  // Lora, headlines only — loaded here so the app itself never pays for it.
  useEffect(() => {
    if (document.getElementById("lora-font")) return;
    const l = document.createElement("link");
    l.id = "lora-font";
    l.rel = "stylesheet";
    l.href =
      "https://fonts.googleapis.com/css2?family=Lora:wght@500;600&display=swap";
    document.head.appendChild(l);
  }, []);

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
      setErr("Couldn't send the code. Try again.");
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
      setErr("That code didn't work. Check it and try again.");
      setBusy(false);
    }
  }

  const band = "mx-auto w-full max-w-[480px] px-5";
  const h2 = "text-[27px] leading-[1.2] font-medium text-[#2c2a26]";

  return (
    <div className="min-h-screen bg-[#fdf6f0] text-[#2c2a26]">
      {/* header */}
      <div className={`${band} pt-6 pb-2 flex items-center gap-2.5`}>
        <div className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-[#455d3b]">
          <ImagePlus size={14} className="text-[#fdf6f0]" strokeWidth={1.8} />
        </div>
        <span style={SERIF} className="text-[17px] font-medium tracking-tight">
          Flanit
        </span>
      </div>

      {/* hero */}
      <div className={`${band} pt-6 pb-11`}>
        <h1
          style={SERIF}
          className="text-[40px] leading-[1.12] font-medium tracking-tight"
        >
          {copy.hero}
        </h1>
        <p className="mt-4 text-[17px] leading-relaxed text-[#6b665c]">
          {copy.sub}
        </p>
        <a
          href="#start"
          className="mt-6 flex h-14 items-center justify-center rounded-full bg-[#455d3b] text-[16.5px] font-medium text-[#fdf6f0] shadow-[0_2px_10px_rgba(69,93,59,0.22)]"
        >
          {copy.cta}
        </a>
        <p className="mt-3 text-center text-[13.5px] text-[#6b665c]">
          2 minutes · guests need nothing
        </p>
        {/* phone mock */}
        <div className="mt-10 flex justify-center">
          <div className="w-[268px] -rotate-3">
            <div className="rounded-[34px] bg-[#2c2a26] p-[9px] shadow-[0_14px_34px_rgba(44,42,38,0.18)]">
              <div className="overflow-hidden rounded-[26px] bg-white">
                <div className="bg-[#edf2eb] px-3.5 pt-4 pb-3">
                  <p style={SERIF} className="text-base font-medium">
                    {copy.mockName}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-[#6b665c]">
                    {copy.mockMeta}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-1.5 p-2.5">
                  <div className="aspect-[3/4] rounded-[10px] bg-[#d8c4ab]" />
                  <div className="aspect-[3/4] rounded-[10px] bg-[#8fa387]" />
                  <div className="aspect-[3/4] rounded-[10px] bg-[#c2a68a]" />
                  <div className="flex aspect-[3/4] flex-col items-center justify-center gap-1.5 rounded-[10px] bg-[#f4efe9]">
                    <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full border-[1.5px] border-dashed border-[#c3bcb0] text-[#6b665c]">
                      +
                    </span>
                    <span className="text-[10.5px] text-[#6b665c]">
                      Add yours
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-2.5 pb-3.5 pt-1">
                  <span className="flex">
                    {["J", "A", "P"].map((c, i) => (
                      <span
                        key={c}
                        className={`flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-white text-[8px] font-medium text-white ${
                          i > 0 ? "-ml-1.5" : ""
                        } ${
                          i === 0
                            ? "bg-[#455d3b]"
                            : i === 1
                            ? "bg-[#8a9a7f]"
                            : "bg-[#c3bcb0]"
                        }`}
                      >
                        {c}
                      </span>
                    ))}
                  </span>
                  <span className="text-[10.5px] text-[#6b665c]">
                    Aunty Jo just added 6 photos
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* how it works */}
      <div className="bg-[#edf2eb] py-12">
        <div className={band}>
          <h2 style={SERIF} className={h2}>
            How it works
          </h2>
          <div className="mt-6 flex flex-col gap-3.5">
            {copy.steps.map((s, i) => (
              <div
                key={s}
                className="flex items-start gap-4 rounded-3xl bg-[#fdf6f0] p-5 shadow-[0_1px_3px_rgba(44,42,38,0.06)]"
              >
                <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-2xl bg-[#edf2eb] text-[#455d3b]">
                  {i === 0 ? (
                    <ImagePlus size={24} strokeWidth={1.5} />
                  ) : i === 1 ? (
                    <QrCode size={24} strokeWidth={1.5} />
                  ) : (
                    <Sparkles size={24} strokeWidth={1.5} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs uppercase tracking-[0.1em] text-[#6b665c]">
                    Step {i === 0 ? "one" : i === 1 ? "two" : "three"}
                  </span>
                  <span className="mt-1 block text-[16.5px] leading-snug">
                    {s}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* the wedge */}
      <div className="py-12">
        <div className={band}>
          <h2 style={SERIF} className="text-[31px] leading-[1.17] font-medium">
            {copy.wedgeTitle}
          </h2>
          <p className="mt-4 text-[16.5px] leading-relaxed text-[#6b665c]">
            {copy.wedgeSub}
          </p>
        </div>
        <div className={`${band} mt-7 flex gap-2.5 overflow-x-auto`}>
          <div className="flex w-[148px] shrink-0 flex-col gap-2.5">
            <Placeholder h={196} tint="#d8c4ab" caption="Getting ready" />
            <Placeholder h={128} tint="#cbb79b" caption="The kids' table" />
          </div>
          <div className="flex w-[148px] shrink-0 flex-col gap-2.5 pt-6">
            <Placeholder h={138} tint="#8fa387" caption="Speeches" />
            <Placeholder h={186} tint="#a3917d" caption="Dance floor, 11pm" />
          </div>
          <div className="flex w-[148px] shrink-0 flex-col gap-2.5 pt-2">
            <Placeholder h={172} tint="#c2a68a" caption="The bus home" />
            <Placeholder h={152} tint="#e0cbb4" caption="Late night" />
          </div>
        </div>
      </div>

      {/* table card */}
      <div className="bg-[#edf2eb] py-12">
        <div className={band}>
          <h2 style={SERIF} className={h2}>
            A card on every table.
          </h2>
          <p className="mt-3.5 text-[16.5px] leading-relaxed text-[#6b665c]">
            {copy.tableSub}
          </p>
          <div className="relative mt-7 overflow-hidden rounded-3xl shadow-[0_2px_12px_rgba(44,42,38,0.1)]">
            <div className="aspect-[4/3] bg-[#cbb79b]" />
            <div className="absolute left-1/2 top-1/2 w-[178px] -translate-x-1/2 -translate-y-1/2 -rotate-2 rounded-xl bg-[#fdf6f0] px-3.5 py-4 text-center shadow-[0_8px_22px_rgba(44,42,38,0.28)]">
              <p style={SERIF} className="text-[14.5px] font-medium leading-tight">
                {copy.mockName}
              </p>
              <p className="mt-1 text-[10.5px] leading-snug text-[#6b665c]">
                Add your photos to our album
              </p>
              <div className="mx-auto mt-2.5 h-[76px] w-[76px] rounded-md bg-white p-[5px]">
                <div
                  className="grid h-full w-full gap-px"
                  style={{
                    gridTemplateColumns: "repeat(7, 1fr)",
                    gridTemplateRows: "repeat(7, 1fr)",
                  }}
                >
                  {QR.split("").map((b, i) => (
                    <span
                      key={i}
                      style={{ background: b === "1" ? "#2c2a26" : "#fff" }}
                    />
                  ))}
                </div>
              </div>
              <p className="mt-2 text-[9.5px] tracking-wide text-[#6b665c]">
                {copy.mockLink}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* the morning after */}
      <div className="py-12">
        <div className={band}>
          <h2 style={SERIF} className={h2}>
            {copy.afterTitle}
          </h2>
          <p className="mt-3.5 text-[16.5px] leading-relaxed text-[#6b665c]">
            {copy.afterSub}
          </p>
          <div className="mt-7 flex flex-col gap-3 rounded-3xl bg-[#edf2eb] p-5">
            <div className="max-w-[88%] self-end rounded-[18px] rounded-br-md bg-[#455d3b] px-4 py-3 text-[15px] leading-snug text-[#f3ede6]">
              {copy.chatMsg}
            </div>
            <div className="w-[250px] max-w-full self-end overflow-hidden rounded-2xl bg-white shadow-[0_1px_4px_rgba(44,42,38,0.1)]">
              <div className="grid grid-cols-3 gap-0.5">
                <div className="aspect-square bg-[#e6ded5]" />
                <div className="aspect-square bg-[#dbd2c6]" />
                <div className="aspect-square bg-[#d3c9bc]" />
              </div>
              <div className="px-3.5 pb-3.5 pt-3">
                <p style={SERIF} className="text-[15px] font-medium leading-tight">
                  {copy.mockName}
                </p>
                <p className="mt-0.5 text-[12.5px] text-[#6b665c]">
                  142 photos, still going
                </p>
                <p className="mt-1.5 truncate text-[11.5px] tracking-wide text-[#6b665c]">
                  {copy.mockLink}
                </p>
              </div>
            </div>
            <div className="max-w-[82%] self-start rounded-[18px] rounded-bl-md bg-[#fdf6f0] px-4 py-3 text-[15px] leading-snug">
              {copy.chatReply}
            </div>
          </div>
        </div>
      </div>

      {/* guests need nothing */}
      <div className="bg-[#edf2eb] py-12">
        <div className={band}>
          <h2 style={SERIF} className={h2}>
            Guests need nothing.
          </h2>
          <div className="mt-7 flex items-start gap-2.5">
            {[
              { cap: "Open the link" },
              { cap: "Add photos" },
              { cap: "Done" },
            ].map((step, i) => (
              <div
                key={step.cap}
                className="flex min-w-0 flex-1 flex-col items-center gap-2.5"
              >
                <div className="w-full rounded-[20px] bg-[#2c2a26] p-[5px]">
                  <div
                    className={`flex aspect-[9/17] flex-col items-center justify-center gap-2 rounded-2xl p-2.5 ${
                      i === 2 ? "bg-[#edf2eb]" : "bg-white"
                    }`}
                  >
                    {i === 0 && (
                      <>
                        <span className="w-full truncate rounded-md bg-[#f0eae3] px-1.5 py-1 text-[6.5px] text-[#6b665c]">
                          {copy.mockLink}
                        </span>
                        <span style={SERIF} className="text-[11px] font-medium">
                          {copy.mockName}
                        </span>
                        <span className="flex h-[15px] w-4/5 items-center justify-center rounded-full bg-[#455d3b] text-[6.5px] font-medium text-[#fdf6f0]">
                          Add photos
                        </span>
                      </>
                    )}
                    {i === 1 && (
                      <>
                        <div className="grid w-full flex-1 grid-cols-2 gap-1">
                          <div className="rounded-[5px] bg-[#e6ded5]" />
                          <div className="rounded-[5px] bg-[#dbd2c6]" />
                          <div className="flex items-center justify-center rounded-[5px] bg-[#edf2eb] text-[9px] text-[#455d3b]">
                            ✓
                          </div>
                          <div className="rounded-[5px] bg-[#f0eae3]" />
                        </div>
                        <span className="flex h-[15px] w-full items-center justify-center rounded-full bg-[#455d3b] text-[6.5px] font-medium text-[#fdf6f0]">
                          Upload 3
                        </span>
                      </>
                    )}
                    {i === 2 && (
                      <>
                        <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-[#455d3b] text-sm text-[#fdf6f0]">
                          ✓
                        </span>
                        <span className="text-[8px]">In the album</span>
                      </>
                    )}
                  </div>
                </div>
                <p className="text-center text-[13px] leading-snug text-[#6b665c]">
                  {step.cap}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-[16.5px]">
            No app. No account. Any phone.
          </p>
        </div>
      </div>

      {/* yours to keep */}
      <div className="bg-[#455d3b] py-[52px]">
        <div className={band}>
          <h2 style={SERIF} className="text-[29px] leading-[1.18] font-medium text-[#fdf6f0]">
            Yours to keep.
          </h2>
          <div className="mt-6 flex flex-col gap-5">
            {[
              {
                icon: <Eye size={20} strokeWidth={1.6} />,
                text: "Watch it fill live on the day, from wherever you are standing.",
              },
              {
                icon: <Download size={20} strokeWidth={1.6} />,
                text: "Download everything afterwards at full resolution, free.",
              },
              {
                icon: <Lock size={20} strokeWidth={1.6} />,
                text: "Private to the people you share it with. Nobody else.",
              },
            ].map((row) => (
              <div key={row.text} className="flex items-start gap-3.5">
                <span className="mt-0.5 shrink-0 text-[#c9d6c2]">{row.icon}</span>
                <p className="min-w-0 flex-1 text-[16.5px] leading-relaxed text-[#f3ede6]">
                  {row.text}
                </p>
              </div>
            ))}
          </div>
          <a
            href="#start"
            className="mt-8 flex h-14 items-center justify-center rounded-full bg-[#fdf6f0] text-[16.5px] font-medium text-[#2c2a26]"
          >
            {copy.cta}
          </a>
        </div>
      </div>

      {/* five albums — weddings only */}
      {copy.fiveAlbums && (
        <div className="py-[52px]">
          <div className={band}>
            <h2 style={SERIF} className="text-[29px] leading-[1.18] font-medium">
              A wedding is five albums.
            </h2>
            <p className="mt-4 text-[16.5px] leading-relaxed text-[#6b665c]">
              The hens, the engagement party, the recovery brunch. Same link,
              every time.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              {[
                "The engagement party",
                "The hens and the bucks",
                "The rehearsal dinner",
                "The wedding",
                "The recovery brunch",
              ].map((label, i) => {
                const hot = i === 3;
                return (
                  <div
                    key={label}
                    className={`flex items-center gap-3 rounded-[18px] px-4 py-3.5 ${
                      hot ? "bg-[#455d3b]" : "bg-[#edf2eb]"
                    }`}
                  >
                    <span
                      style={SERIF}
                      className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl text-[13px] ${
                        hot
                          ? "bg-[#fdf6f0]/15 text-[#fdf6f0]"
                          : "bg-[#fdf6f0] text-[#455d3b]"
                      }`}
                    >
                      0{i + 1}
                    </span>
                    <span
                      className={`min-w-0 flex-1 text-[15.5px] ${
                        hot ? "font-medium text-[#fdf6f0]" : ""
                      }`}
                    >
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* FAQ */}
      <div className="bg-[#edf2eb] py-12">
        <div className={band}>
          <h2 style={SERIF} className={h2}>
            Questions
          </h2>
          <div className="mt-5 flex flex-col gap-3">
            {[
              {
                q: "Is it really free?",
                a: "Yes. Creating the album, collecting the photos and downloading them all at full resolution costs nothing.",
              },
              {
                q: "Do videos work too?",
                a: "They do. Guests can add short videos the same way they add photos, and they sit in the same album.",
              },
              {
                q: "Who can see the album?",
                a: "Only the people with your link. It isn't listed anywhere and it isn't searchable.",
              },
              {
                q: "When should we share the link?",
                a: copy.faqShare,
              },
            ].map((f) => (
              <div key={f.q} className="rounded-[20px] bg-[#fdf6f0] p-[19px]">
                <p className="text-[15.5px] font-medium">{f.q}</p>
                <p className="mt-1.5 text-[15px] leading-relaxed text-[#6b665c]">
                  {f.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* signup card — the Aug 30 machinery in the new clothes */}
      <div id="start" className="scroll-mt-5 py-[52px] pb-16">
        <div className={band}>
          <div className="rounded-3xl bg-white p-6 shadow-[0_2px_14px_rgba(44,42,38,0.09)]">
            {me === undefined ? (
              <p className="py-2 text-center text-sm text-[#6b665c]">…</p>
            ) : me ? (
              <>
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#455d3b] text-base font-medium text-[#fdf6f0]">
                    {(me.name || "?").trim().charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p style={SERIF} className="text-xl font-medium leading-snug">
                      Welcome back, {me.name}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-[15.5px] leading-relaxed text-[#6b665c]">
                  Your albums are already here. Start a new one.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    await brevoUpsert(variant);
                    goCreate();
                  }}
                  className="mt-5 flex h-[54px] w-full items-center justify-center rounded-full bg-[#455d3b] text-[16.5px] font-medium text-[#fdf6f0] active:scale-[0.99] transition"
                >
                  {copy.cta}
                </button>
                <p className="mt-3 text-center text-[13.5px] text-[#6b665c]">
                  2 minutes · guests need nothing
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    await supabase.auth.signOut();
                    window.location.reload();
                  }}
                  className="mt-4 w-full text-center text-sm text-[#455d3b] underline underline-offset-[3px]"
                >
                  Not you? Sign out
                </button>
              </>
            ) : phase === null ? (
              <>
                <h2
                  style={SERIF}
                  className="text-[25px] font-medium leading-tight"
                >
                  {mode === "create" ? copy.cardTitle : "Sign in to Flanit"}
                </h2>
                <p className="mt-3 text-[15.5px] leading-relaxed text-[#6b665c]">
                  {mode === "create"
                    ? "Pop in your email and we'll send you a code. No password to remember."
                    : "Same email you used last time. We'll send a code to it. This lands in your Events tab everywhere you're signed in."}
                </p>
                <label
                  htmlFor="landing-email"
                  className="mt-5 block text-[13px] text-[#6b665c]"
                >
                  Your email
                </label>
                <input
                  id="landing-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendCode()}
                  placeholder="you@email.com"
                  className="mt-2 h-[52px] w-full rounded-2xl border border-[#e3dcd3] bg-[#fdf6f0] px-4 text-base outline-none focus:border-[#455d3b] focus:bg-white"
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
                  className="mt-2 flex h-[54px] w-full items-center justify-center rounded-full bg-[#455d3b] text-[16.5px] font-medium text-[#fdf6f0] disabled:opacity-60 active:scale-[0.99] transition"
                >
                  {busy ? "Sending…" : "Send me a code"}
                </button>
                {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
                <p className="mt-5 border-t border-[#f0eae3] pt-[18px] text-center text-sm text-[#6b665c]">
                  {mode === "create" ? (
                    <>
                      Already on Flanit?{" "}
                      <button
                        type="button"
                        onClick={() => setMode("signin")}
                        className="text-[#455d3b] underline underline-offset-[3px]"
                      >
                        Sign in
                      </button>
                    </>
                  ) : (
                    <>
                      Need an album?{" "}
                      <button
                        type="button"
                        onClick={() => setMode("create")}
                        className="text-[#455d3b] underline underline-offset-[3px]"
                      >
                        Create one, free
                      </button>
                    </>
                  )}
                </p>
              </>
            ) : (
              <>
                <h2
                  style={SERIF}
                  className="text-[25px] font-medium leading-tight"
                >
                  Check your email
                </h2>
                <p className="mt-3 text-[15.5px] leading-relaxed text-[#6b665c]">
                  We sent a 6-digit code to {email.trim()}.
                </p>
                <input
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitCode()}
                  placeholder="123456"
                  maxLength={6}
                  className="mt-4 h-[52px] w-full rounded-2xl border border-[#e3dcd3] bg-[#fdf6f0] px-4 text-base tracking-widest outline-none focus:border-[#455d3b] focus:bg-white"
                />
                <button
                  type="button"
                  disabled={busy || !code.trim()}
                  onClick={submitCode}
                  className="mt-3 flex h-[54px] w-full items-center justify-center rounded-full bg-[#455d3b] text-[16.5px] font-medium text-[#fdf6f0] disabled:opacity-60 active:scale-[0.99] transition"
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
                  className="mt-4 w-full text-center text-sm text-[#6b665c] underline underline-offset-[3px]"
                >
                  Different email
                </button>
              </>
            )}
          </div>
          <p className="mt-6 text-center text-[13px] leading-relaxed text-[#6b665c]">
            Flanit · flanit.co
          </p>
        </div>
      </div>
    </div>
  );
}
