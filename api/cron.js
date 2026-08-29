// THE SERVER CLOCK (Aug 21, 2026) — poked every 10 minutes by Supabase
// pg_cron (see flanit_cron.sql). Time-based sends finally reach lock
// screens with no app open anywhere:
//   1. PLAN REMINDERS  — "You're going to X 🎉" within the hour before a
//                        locked plan's slot (Mark: "the date set should
//                        nudge as a reminder. You're going here tonight").
//   2. DID-YOU-GO      — dated plans, first pass after 10am Melbourne the
//                        morning after; skips anyone who checked in.
//   3. PHOTO NUDGES    — own photoless night, 12–36h old, kind-aware copy
//                        (plain night = create the album; album = add).
//   4. TIME'S UP       — one clean push to the host when an undecided
//                        session's clock runs out (replaces duplicate
//                        guest-device sends).
//   5. EVENT REMINDERS — hour before an is_event night: owner + everyone
//                        who ACCEPTED an invite (Aug 30, Mark's probe: the
//                        accepted tag is the RSVP-yes we already have;
//                        pending = asked, not coming yet, no buzz).
// Every send is logged in nudge_log with a UNIQUE(kind, target, user) —
// a nudge can never fire twice, however often the clock ticks. Nudges
// (2, 3) respect quiet hours (9:00–21:00 Melbourne); reminders (1) and
// time's-up (4) are the point of the moment and are exempt.
//
// Env: CRON_SECRET (matches the SQL's x-cron-key), plus the push trio
// already present (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// SUPABASE_SERVICE_ROLE_KEY, REACT_APP_SUPABASE_URL/SUPABASE_URL).
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;

function melbourneHour(now = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Australia/Melbourne",
      hour: "2-digit",
      hour12: false,
    }).format(now)
  );
}

export default async function handler(req, res) {
  const key = req.headers["x-cron-key"] || req.query?.key;
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "bad key" });
  }
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv || !SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "not configured" });
  }
  webpush.setVapidDetails("mailto:mark@sayi.do", pub, priv);
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const now = new Date();
  const nowMs = now.getTime();
  const hourMelb = melbourneHour(now);
  const quiet = hourMelb < 9 || hourMelb >= 21; // nudges hold; reminders don't
  const summary = { reminders: 0, didYouGo: 0, photoNudges: 0, timeups: 0, eventReminders: 0, errors: [] };

  // Send to every subscription a user has; prune dead ones. Quietly a
  // no-op for users with no subscriptions (never enabled push).
  async function push(userId, title, body) {
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", userId);
    let sent = 0;
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: title.slice(0, 80), body: (body || "").slice(0, 160), url: "/" })
        );
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        }
      }
    }
    return sent;
  }

  // The send-once gate: winning the insert wins the right to push.
  async function claim(kind, targetKey, userId) {
    const { error } = await admin
      .from("nudge_log")
      .insert({ kind, target_key: String(targetKey), user_id: userId });
    return !error; // 23505 (already sent) or anything else → don't send
  }

  try {
    // ---- 1. PLAN REMINDERS: slot within the next hour ----
    const inHour = new Date(nowMs + 60 * 60 * 1000).toISOString();
    const { data: plans } = await admin
      .from("match_sessions")
      .select("id, decided_venue_id, decided_for")
      .not("decided_venue_id", "is", null)
      .gte("decided_for", now.toISOString())
      .lte("decided_for", inHour)
      .limit(50);
    for (const p of plans || []) {
      const { data: venue } = await admin
        .from("venues")
        .select("name")
        .eq("id", p.decided_venue_id)
        .maybeSingle();
      const vName = venue?.name || "your spot";
      const t = new Date(p.decided_for);
      const timeTxt = t.toLocaleTimeString("en-AU", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Australia/Melbourne",
      });
      const { data: parts } = await admin
        .from("session_participants")
        .select("user_id")
        .eq("session_id", p.id);
      for (const part of parts || []) {
        if (!part.user_id) continue;
        if (await claim("plan_reminder", p.id, part.user_id)) {
          summary.reminders += await push(
            part.user_id,
            `You're going to ${vName} 🎉`,
            `${timeTxt}, see you there`
          );
        }
      }
    }

    // ---- 2. DID-YOU-GO: dated plans, morning after, 10am+ Melbourne ----
    if (!quiet && hourMelb >= 10) {
      const from = new Date(nowMs - 48 * 60 * 60 * 1000).toISOString();
      const to = new Date(nowMs - 12 * 60 * 60 * 1000).toISOString();
      const { data: sess } = await admin
        .from("match_sessions")
        .select("id, decided_venue_id, decided_for")
        .not("decided_venue_id", "is", null)
        .gte("decided_for", from)
        .lte("decided_for", to)
        .limit(50);
      for (const s of sess || []) {
        const { data: venue } = await admin
          .from("venues")
          .select("name")
          .eq("id", s.decided_venue_id)
          .maybeSingle();
        const vName = venue?.name || "the spot you picked";
        const { data: parts } = await admin
          .from("session_participants")
          .select("user_id")
          .eq("session_id", s.id);
        for (const part of parts || []) {
          if (!part.user_id) continue;
          // Already checked in near the plan = we know they went.
          const ref = new Date(s.decided_for).getTime();
          const { data: went } = await admin
            .from("activities")
            .select("id")
            .eq("user_id", part.user_id)
            .eq("venue_id", s.decided_venue_id)
            .eq("kind", "checkin")
            .gte("created_at", new Date(ref - 48 * 3600 * 1000).toISOString())
            .lte("created_at", new Date(ref + 48 * 3600 * 1000).toISOString())
            .limit(1);
          if (went && went.length > 0) continue;
          if (await claim("did_you_go", s.id, part.user_id)) {
            summary.didYouGo += await push(
              part.user_id,
              `Did you go to ${vName}?`,
              "Tell us in Flanit, it lands in your Been list"
            );
          }
        }
      }
    }

    // ---- 3. PHOTO NUDGES: own photoless nights, 12–36h old ----
    if (!quiet) {
      const from = new Date(nowMs - 36 * 60 * 60 * 1000).toISOString();
      const to = new Date(nowMs - 12 * 60 * 60 * 1000).toISOString();
      const { data: acts } = await admin
        .from("activities")
        .select("id, user_id, venue_id, is_album")
        .eq("kind", "checkin")
        .gte("created_at", from)
        .lte("created_at", to)
        .limit(100);
      const ids = (acts || []).map((a) => a.id);
      let hasPhotos = new Set();
      if (ids.length > 0) {
        const { data: ph } = await admin
          .from("activity_photos")
          .select("activity_id")
          .in("activity_id", ids);
        hasPhotos = new Set((ph || []).map((p) => p.activity_id));
      }
      for (const a of acts || []) {
        if (hasPhotos.has(a.id)) continue;
        const { data: venue } = a.venue_id
          ? await admin.from("venues").select("name").eq("id", a.venue_id).maybeSingle()
          : { data: null };
        const vName = venue?.name || "last night";
        if (await claim("photo_nudge", a.id, a.user_id)) {
          summary.photoNudges += await push(
            a.user_id,
            a.is_album
              ? `Add photos from ${vName} 📸`
              : `Collect photos from ${vName}?`,
            a.is_album
              ? "Last night's album, while it's still fresh"
              : "Create the album while the night's still fresh"
          );
        }
      }
    }

    // ---- 4. TIME'S UP: expired undecided sessions → ONE host push ----
    const expFrom = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const { data: expired } = await admin
      .from("match_sessions")
      .select("id, host_user_id, expires_at, decided_venue_id, mode")
      .eq("mode", "concurrent")
      .is("decided_venue_id", null)
      .gte("expires_at", expFrom)
      .lte("expires_at", now.toISOString())
      .limit(50);
    for (const s of expired || []) {
      const { data: parts } = await admin
        .from("session_participants")
        .select("user_id, submitted_at")
        .eq("session_id", s.id);
      const submitted = (parts || []).filter(
        (p) => p.user_id !== s.host_user_id && p.submitted_at
      ).length;
      if (submitted === 0) continue; // nothing to look at — no push
      if (await claim("timeup", s.id, s.host_user_id)) {
        summary.timeups += await push(
          s.host_user_id,
          "⏰ Time's up on your session",
          `${submitted} sent picks, see the results`
        );
      }
    }
    // ---- 5. EVENT REMINDERS: is_event night starting within the hour ----
    // Audience = owner + accepted tags on the night. Like plan reminders,
    // this is the point of the moment — exempt from quiet hours.
    const { data: events } = await admin
      .from("activities")
      .select("id, user_id, venue_id, label, created_at")
      .eq("kind", "checkin")
      .eq("is_event", true)
      .gte("created_at", now.toISOString())
      .lte("created_at", inHour)
      .limit(50);
    for (const ev of events || []) {
      const { data: venue } = ev.venue_id
        ? await admin.from("venues").select("name").eq("id", ev.venue_id).maybeSingle()
        : { data: null };
      const what = ev.label || venue?.name || "your event";
      const where = ev.label && venue?.name ? ` at ${venue.name}` : "";
      const timeTxt = new Date(ev.created_at).toLocaleTimeString("en-AU", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Australia/Melbourne",
      });
      const { data: tags } = await admin
        .from("activity_tags")
        .select("tagged_user_id")
        .eq("activity_id", ev.id)
        .eq("status", "accepted");
      const people = new Set([ev.user_id, ...(tags || []).map((t) => t.tagged_user_id)]);
      for (const uid of people) {
        if (!uid) continue;
        if (await claim("event_reminder", ev.id, uid)) {
          summary.eventReminders += await push(
            uid,
            `${what} is tonight 🎉`,
            `${timeTxt}${where}, see you there`
          );
        }
      }
    }
  } catch (e) {
    summary.errors.push((e.message || "").slice(0, 200));
  }

  return res.status(200).json(summary);
}
