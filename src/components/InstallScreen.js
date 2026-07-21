// flanit.co/install — the app-store-style landing (July 18, 2026; pattern
// borrowed from sayi.do/install). Desktop: QR that sends people to this page
// on their phone. Mobile: install card. Platform-aware action:
//   Android/Chrome  → real install prompt (beforeinstallprompt, captured at
//                     module load — it fires before React mounts)
//   iOS Safari      → step instructions (Apple allows no programmatic A2HS)
//   In-app browser  → "open in Safari/Chrome first" (A2HS doesn't exist there)
//   Already installed → all set.
import { useEffect, useState } from "react";

// Must be captured at module scope: Chrome fires this once, early.
let deferredInstallPrompt = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
}

const isInAppBrowser = () =>
  /Instagram|FBAN|FBAV|FB_IAB|Line|Twitter|TikTok|Snapchat|Pinterest|MicroMessenger/i.test(
    navigator.userAgent
  );
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isAndroid = () => /Android/i.test(navigator.userAgent);
const isInstalled = () =>
  window.matchMedia?.("(display-mode: standalone)")?.matches ||
  window.navigator.standalone === true;

export function InstallScreen() {
  const [qr, setQr] = useState(null);
  const [showSteps, setShowSteps] = useState(false);
  const [copied, setCopied] = useState(false);
  const mobile = isIOS() || isAndroid();

  useEffect(() => {
    if (mobile) return;
    let cancelled = false;
    // qrcode is only needed on desktop — load it lazily.
    import("qrcode")
      .then((QR) =>
        (QR.toDataURL || QR.default.toDataURL)("https://flanit.co/install", {
          width: 240,
          margin: 1,
          color: { dark: "#2f3f29", light: "#ffffff" },
        })
      )
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mobile]);

  async function install() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => {});
      deferredInstallPrompt = null;
      return;
    }
    setShowSteps(true);
  }

  function copyLink() {
    try {
      navigator.clipboard.writeText("https://flanit.co/install");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  return (
    <div className="min-h-screen bg-[#fdf6f0] flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-3xl bg-white border border-neutral-100 shadow-sm p-6 text-center">
        <img
          src="/icon-192.png"
          alt="Flanit"
          className="mx-auto h-20 w-20 rounded-3xl shadow-md"
        />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Flanit</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Find a place, together.
        </p>
        <p className="mt-1 text-[11px] text-neutral-400">
          Free · straight from the web — no app store needed
        </p>

        {isInstalled() ? (
          <p className="mt-6 rounded-full bg-[#edf2eb] border border-[#cdd9c6] py-3 text-sm font-medium text-[#455d3b]">
            You've got it ✓ — open Flanit from your home screen
          </p>
        ) : !mobile ? (
          <div className="mt-6">
            {qr ? (
              <img
                src={qr}
                alt="QR code to flanit.co/install"
                className="mx-auto rounded-xl"
              />
            ) : (
              <div className="mx-auto h-[240px] w-[240px] rounded-xl bg-neutral-100" />
            )}
            <p className="mt-3 text-xs text-neutral-500">
              Scan with your phone camera to install
            </p>
          </div>
        ) : isInAppBrowser() ? (
          <div className="mt-6 text-left">
            <p className="text-sm text-neutral-700">
              You're inside another app's browser — installing needs{" "}
              {isIOS() ? "Safari" : "Chrome"}.
            </p>
            <ol className="mt-3 space-y-2 text-sm text-neutral-600 list-decimal list-inside">
              <li>Tap the ⋯ menu in the corner</li>
              <li>Choose "Open in {isIOS() ? "Safari" : "Chrome"}"</li>
              <li>Then tap Install here</li>
            </ol>
            <button
              type="button"
              onClick={copyLink}
              className="mt-4 w-full rounded-full border border-neutral-200 py-2.5 text-xs font-medium text-neutral-600 active:scale-[0.99] transition"
            >
              {copied ? "Copied ✓" : "Copy link instead"}
            </button>
          </div>
        ) : (
          <div className="mt-6">
            <button
              type="button"
              onClick={install}
              className="w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white active:scale-[0.99] transition"
            >
              Install
            </button>
            {showSteps && isIOS() && (
              <ol className="mt-4 space-y-2 text-left text-sm text-neutral-600 list-decimal list-inside">
                <li>
                  Tap the <span className="font-medium">Share</span> button{" "}
                  <span aria-hidden>⎋</span> in Safari's toolbar
                </li>
                <li>
                  Scroll and choose{" "}
                  <span className="font-medium">Add to Home Screen</span>
                </li>
                <li>Open Flanit from your home screen</li>
              </ol>
            )}
            {showSteps && !isIOS() && (
              <ol className="mt-4 space-y-2 text-left text-sm text-neutral-600 list-decimal list-inside">
                <li>Tap the ⋮ menu in Chrome</li>
                <li>
                  Choose <span className="font-medium">Add to Home screen</span>
                </li>
                <li>Open Flanit from your home screen</li>
              </ol>
            )}
          </div>
        )}

        <a
          href="/"
          className="mt-5 inline-block text-xs text-neutral-400 underline underline-offset-2"
        >
          or keep using flanit.co in the browser
        </a>
      </div>
    </div>
  );
}
