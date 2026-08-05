// Web push, client side (July 19, 2026).
// iOS reality: push works ONLY when Flanit is installed to the home screen
// (16.4+), and the permission request must come from a user tap. The service
// worker (public/sw.js) is push-only — it never intercepts fetches.
import { supabase } from "../supabaseClient";

export function isPushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)")?.matches ||
  window.navigator.standalone === true;

// What the enable UI should show.
//  granted | default | denied | need-install | unsupported
export function pushState() {
  if (isIOS() && !isStandalone()) return "need-install";
  if (!isPushSupported()) return "unsupported";
  return Notification.permission; // granted | default | denied
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    console.warn("SW register failed:", e);
    return null;
  }
}

// Must be called from a user gesture (iOS requirement). Returns
// "granted" | "denied" | "error".
export async function enablePush(userId) {
  try {
    const reg = await registerServiceWorker();
    if (!reg) return "error";
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return permission;

    const keyRes = await fetch("/api/send-push");
    const { publicKey } = await keyRes.json();
    if (!publicKey) return "error";

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = sub.toJSON();
    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: userId,
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      },
      { onConflict: "endpoint" }
    );
    if (error) {
      console.error("Push subscription save failed:", error);
      return "error";
    }
    return "granted";
  } catch (e) {
    console.error("enablePush failed:", e);
    return "error";
  }
}

// Fire-and-forget notify — failures are silent by design (a missed push
// must never break the interaction that triggered it).
//
// `keepalive` is load-bearing (July 31, Mark: "not all notifications are
// working when a phone is locked"). This fetch is deliberately not awaited, so
// without the flag the browser CANCELS it the moment the page is hidden or
// unloaded — locking the phone, switching apps, closing the card. The push was
// never sent; nothing reached the server to fail, which is why it looked
// intermittent and left no trace. keepalive lets the request outlive the page,
// the same guarantee sendBeacon gives. (Cap: 64KB of body across all keepalive
// requests in flight — these are a few hundred bytes.)
export async function sendPush(targetUserId, title, body, url = "/") {
  try {
    if (!targetUserId) return;
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return;
    fetch("/api/send-push", {
      method: "POST",
      keepalive: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ targetUserId, title, body, url }),
    }).catch(() => {});
  } catch {}
}
