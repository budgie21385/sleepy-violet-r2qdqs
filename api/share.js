// Per-link social previews for shared routes (/v /s /u). Crawlers (WhatsApp,
// Messenger, iMessage, Slack, Facebook, Twitter…) don't run JS, so they only
// read the served HTML's meta tags. This function fetches the venue / session /
// profile, rewrites the Open Graph + Twitter tags in index.html to match, and
// returns the page — the React app then boots as normal for real users.
//
// Robust by design: any failure falls back to the branded default tags already
// in index.html, so a share link never breaks.
//
// Wired via vercel.json rewrites:
//   /v/:id     -> /api/share?type=venue&id=:id
//   /s/:id     -> /api/share?type=session&id=:id
//   /u/:handle -> /api/share?type=profile&handle=:handle

const SUPABASE_URL =
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL || "";
const ANON =
  process.env.REACT_APP_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  const host = req.headers.host || "flanit.co";
  const origin = `https://${host}`;
  const { type, id, handle } = req.query || {};

  // Branded defaults (match the tags already in index.html).
  let title = "Discover your city with friends";
  let description = "Swipe, match and decide where to go — together.";
  let image = `${origin}/og-default.png`;
  let url = origin;

  try {
    if (type === "venue" && id) {
      const r = await sb("rpc/get_public_venue", {
        method: "POST",
        body: JSON.stringify({ p_venue_id: Number(id) }),
      });
      const rows = await r.json();
      const v = Array.isArray(rows) ? rows[0] : rows;
      if (v && v.name) {
        title = `Check out ${v.name} on Flanit`;
        const bits = [v.type, v.suburb].filter(Boolean).join(" · ");
        description = bits
          ? `${bits}. See photos, hours and directions.`
          : "See photos, hours and directions.";
        const cdn = Array.isArray(v.image_cdn_urls) ? v.image_cdn_urls[0] : null;
        const proxied =
          Array.isArray(v.image_urls) && v.image_urls[0]
            ? `${origin}/api/place-photo?url=${encodeURIComponent(v.image_urls[0])}`
            : null;
        image = cdn || proxied || image;
        url = `${origin}/v/${id}`;
      }
    } else if (type === "session" && id) {
      const r = await sb(`match_sessions?id=eq.${id}&select=name,mode,host_user_id`);
      const s = (await r.json())[0];
      if (s) {
        let hostName = "A friend";
        try {
          const hr = await sb(
            `profiles?id=eq.${s.host_user_id}&select=display_name,username`
          );
          const hp = (await hr.json())[0];
          if (hp)
            hostName =
              (hp.display_name && hp.display_name.trim()) ||
              (hp.username ? `@${hp.username}` : hostName);
        } catch (e) {
          /* keep default host name */
        }
        if (s.mode === "curated") {
          title = `${hostName} sent you a shortlist`;
          description = "Vote on the shortlist and help decide where you're going.";
          image = `${origin}/og-shortlist.png`;
        } else {
          title = `Join ${hostName}'s session on Flanit`;
          description = "Right now — swipe together and see what you match on.";
          image = `${origin}/og-rightnow.png`;
        }
        url = `${origin}/s/${id}`;
      }
    } else if (type === "profile" && handle) {
      const clean = String(handle).replace(/^@/, "");
      const r = await sb(
        `profiles?username=ilike.${encodeURIComponent(clean)}&select=display_name,username`
      );
      const p = (await r.json())[0];
      const name = p
        ? (p.display_name && p.display_name.trim()) || `@${p.username}`
        : `@${clean}`;
      title = `${name} invited you to Flanit`;
      description = "Swipe, match and decide where to go — together.";
      image = `${origin}/og-invite.png`;
      url = `${origin}/u/@${clean}`;
    }
  } catch (e) {
    // fall through to branded defaults
  }

  // Grab the built index.html and swap the preview tags.
  let html;
  try {
    const resp = await fetch(`${origin}/index.html`);
    html = await resp.text();
  } catch (e) {
    // Last resort: bounce to the app so the link still works.
    res.setHeader("Location", url);
    res.status(302).end();
    return;
  }

  html = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(
      /(<meta name="description" content=")[^"]*(">)/,
      `$1${esc(description)}$2`
    )
    .replace(
      /(<meta property="og:title" content=")[^"]*(">)/,
      `$1${esc(title)}$2`
    )
    .replace(
      /(<meta property="og:description" content=")[^"]*(">)/,
      `$1${esc(description)}$2`
    )
    .replace(
      /(<meta property="og:image" content=")[^"]*(">)/,
      `$1${esc(image)}$2`
    )
    .replace(/(<meta property="og:url" content=")[^"]*(">)/, `$1${esc(url)}$2`)
    .replace(
      /(<meta name="twitter:title" content=")[^"]*(">)/,
      `$1${esc(title)}$2`
    )
    .replace(
      /(<meta name="twitter:description" content=")[^"]*(">)/,
      `$1${esc(description)}$2`
    )
    .replace(
      /(<meta name="twitter:image" content=")[^"]*(">)/,
      `$1${esc(image)}$2`
    );

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    "public, max-age=0, s-maxage=600, stale-while-revalidate=86400"
  );
  res.status(200).send(html);
}
