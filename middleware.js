// EDGE DOOR (Oct 15, 2026) — flanit.co/ is ONE address: the homepage for
// strangers, the app for members. Decided here at the edge so the URL never
// visibly shuffles to /home/ (Mark: "we have just /. No /home").
//
// How membership is known: the app sets a `flanit_in=1` cookie on sign-in
// (and on load for already-signed-in users) and clears it on sign-out —
// the Supabase session itself lives in localStorage, which the edge can't
// read, so the cookie is its edge-visible shadow. If the cookie is ever
// missing for a real member, the homepage's self-heal script restores it
// and reloads (see public/home/index.html).
//
// Scope: EXACTLY "/" with no query string. Anything else — ?signin=1,
// ?night deep links, /s/ /v/ /u/ /c/ shares, static assets — passes
// straight through to the app and its routes.
export const config = { matcher: "/" };

export default function middleware(request) {
  const url = new URL(request.url);
  if (url.search) return; // deep links and ?signin=1 belong to the app
  const cookies = request.headers.get("cookie") || "";
  if (/(?:^|;\s*)flanit_in=1(?:;|$)/.test(cookies)) return; // member → app
  // Stranger → serve the homepage AT "/" (internal rewrite, URL unchanged).
  return new Response(null, {
    headers: {
      "x-middleware-rewrite": new URL("/home/index.html", request.url).toString(),
    },
  });
}
