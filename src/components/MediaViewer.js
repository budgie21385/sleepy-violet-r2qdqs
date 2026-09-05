// Full-screen media viewer (Mark's design, Sept 2026 — "Turn 5 · Quiet by
// default"). Replaces the white floating lightbox card in CheckinThreadSheet.
//
// The photo owns the whole frame. Chrome floats on it over two soft scrims:
//   top    — "3/20" counter left, Save · Delete · X cluster right
//   sides  — prev/next arrows (only when there IS a prev/next); swipe works too
//   bottom — author line left, a Reactions pill and a Comments pill right
// Tapping the photo itself exits. Each pill opens ITS OWN sheet over a dimmed
// photo, so the frame never carries more than one thing at a time:
//   comments  — thread + input, covers the lower ~58% of the screen
//   reactions — six-emoji picker (yours highlighted) + who-reacted list,
//               scoped to the photo or to one comment ("N reacted ›" / ⊕)
// Landscape media letterboxes on black and shifts UP into the top half while
// a sheet is open so nothing sits behind it; portrait fills the frame and the
// sheets simply cover its lower half (the top stays visible and tappable).
//
// Videos keep native controls, so a tap on the video plays/pauses rather than
// exiting — the letterbox around it, the X, and Escape are the way out.
//
// This component is presentational + gesture state only. Data (comments,
// reactions, delete, save) stays in CheckinThreadSheet, which already owns
// the fetches, RLS assumptions and push doctrine; it comes in as props.
import { useEffect, useRef, useState } from "react";
import {
  X,
  Send,
  ChevronLeft,
  ChevronRight,
  Download,
  Trash2,
  MessageCircle,
  SmilePlus,
  Plus,
} from "lucide-react";
import { FriendAvatar } from "./FriendAvatar";
import { timeAgoShort } from "../lib/checkins";
import { REACTION_SET, summarizeReactions } from "../lib/reactions";

const SWIPE_PX = 40;
const PILL =
  "flex items-center rounded-full bg-[#1c1c1e]/60 backdrop-blur-xl text-white active:scale-95 transition";

function firstName(profile, fallback = "Someone") {
  return (profile?.display_name || profile?.username || fallback).split(" ")[0];
}

export function MediaViewer({
  photos,
  photo, // current row
  onStep, // (dir) => void
  onClose,
  userId,
  mediaProfiles,
  onOpenProfile,
  // reactions
  reactions,
  reacting,
  onReact, // (emoji, photo, comment|null)
  // comments
  comments, // null = loading
  commentBody,
  onCommentBodyChange,
  onSendComment,
  sending,
  // save / delete
  canDelete,
  deleteArm,
  onArmDelete, // () => void  (first tap)
  onDelete, // () => void  (second tap)
  deleting,
  downloading,
  onSave,
  isIOS,
  // deep-link: open with the comments sheet already up
  initialSheet = null,
}) {
  // sheet: null | { kind: "comments" } | { kind: "reactions", comment: row|null }
  const [sheet, setSheet] = useState(
    initialSheet === "comments" ? { kind: "comments" } : null
  );
  const [landscape, setLandscape] = useState(false);
  const touch = useRef(null);
  const inputRef = useRef(null);

  const idx = photos.findIndex((p) => p.id === photo.id);
  const total = photos.length;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < total - 1;

  // Sheets are per-photo — flipping photos closes whatever was open, and the
  // aspect ratio is re-measured off the next image. (First render keeps the
  // deep-link sheet; only subsequent flips reset.)
  const firstPhoto = useRef(photo.id);
  useEffect(() => {
    if (firstPhoto.current === photo.id) return;
    firstPhoto.current = null;
    setSheet(null);
    setLandscape(false);
  }, [photo.id]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        if (sheet) setSheet(null);
        else onClose();
      } else if (e.key === "ArrowLeft" && hasPrev) onStep(-1);
      else if (e.key === "ArrowRight" && hasNext) onStep(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, hasPrev, hasNext, onStep, onClose]);

  // Focus the input when the comments sheet opens so the keyboard is one tap
  // fewer away — but not on the deep-link open (the person came to READ).
  useEffect(() => {
    if (sheet?.kind === "comments" && initialSheet !== "comments") {
      inputRef.current?.focus?.();
    }
  }, [sheet?.kind, initialSheet]);

  const isVideo = photo.kind === "video" && photo.videoUrl;
  const authorProfile = mediaProfiles[photo.user_id];
  const isMine = photo.user_id === userId;
  const photoSummary = summarizeReactions(reactions, userId, photo.id);
  const reactionTotal = Object.values(photoSummary.counts).reduce(
    (s, n) => s + n,
    0
  );
  // Top three emoji by use, overlapped so the pill stays narrow however many
  // kinds get used.
  const topEmoji = Object.entries(photoSummary.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([e]) => e);
  const commentCount = comments ? comments.length : null;

  function onTouchStart(e) {
    const t = e.touches[0];
    touch.current = t ? { x: t.clientX, y: t.clientY } : null;
  }
  function onTouchEnd(e) {
    if (!touch.current) return;
    const t = e.changedTouches[0];
    const dx = (t?.clientX ?? touch.current.x) - touch.current.x;
    const dy = (t?.clientY ?? touch.current.y) - touch.current.y;
    touch.current = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0 && hasNext) onStep(1);
      if (dx > 0 && hasPrev) onStep(-1);
    } else if (dy > SWIPE_PX && Math.abs(dy) > Math.abs(dx)) {
      // Swipe DOWN dismisses (Sep 6, Mark) — the photo-viewer convention.
      // Down only: up is reserved (and up-to-close feels like a throw).
      if (sheet) setSheet(null);
      else onClose();
    }
  }

  const sheetOpen = !!sheet;
  const sheetComment = sheet?.kind === "reactions" ? sheet.comment : null;
  const sheetSummary =
    sheet?.kind === "reactions"
      ? sheetComment
        ? summarizeReactions(reactions, userId, null, sheetComment.id)
        : photoSummary
      : null;
  const whoRows =
    sheet?.kind === "reactions"
      ? reactions.filter((r) => {
          const pid = r.photo_id ?? null;
          const cid = r.comment_id ?? null;
          if (sheetComment) return cid === sheetComment.id;
          return pid === photo.id && cid === null;
        })
      : [];

  return (
    <div
      className="fixed inset-0 z-[3800] bg-black text-white/85 overflow-hidden select-none"
      role="dialog"
      aria-modal="true"
    >
      {/* MEDIA — fills the frame; shifts into the top half when a sheet is
          open on a landscape photo so the image is never behind the sheet. */}
      <div
        className="absolute inset-x-0 top-0 transition-[bottom] duration-300 ease-out"
        style={{ bottom: sheetOpen && landscape && !isVideo ? "58%" : 0 }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={() => {
          if (sheetOpen) setSheet(null);
          else onClose();
        }}
      >
        {isVideo ? (
          <video
            src={photo.videoUrl}
            poster={photo.url || undefined}
            controls
            playsInline
            autoPlay
            onClick={(e) => e.stopPropagation()}
            className="h-full w-full object-contain"
          />
        ) : (
          <img
            src={photo.url}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              setLandscape(el.naturalWidth > el.naturalHeight);
            }}
            className="h-full w-full object-contain"
          />
        )}
      </div>

      {/* Scrims — light, so the chrome reads on a bright photo. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-black/60 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/60 to-transparent" />

      {/* TOP ROW — counter · Save/Delete/X cluster */}
      <div
        className="absolute inset-x-0 z-[3] flex items-center justify-between px-5"
        style={{ top: "max(14px, env(safe-area-inset-top))" }}
      >
        <span className="text-[13px] font-medium text-white/85 tabular-nums">
          {total > 1 ? `${idx + 1}/${total}` : ""}
        </span>
        <div className={`${PILL} h-[38px] px-1 active:scale-100`}>
          {photo.orig_path && (
            <button
              type="button"
              aria-label="Save original"
              disabled={downloading}
              onClick={() => onSave(photo)}
              className="flex h-[38px] w-[36px] items-center justify-center rounded-full active:bg-white/15 disabled:opacity-70"
            >
              {downloading ? (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              ) : (
                <Download size={16} strokeWidth={1.7} />
              )}
            </button>
          )}
          {canDelete && (
            <>
              {photo.orig_path && <span className="h-[18px] w-px bg-white/20" />}
              <button
                type="button"
                aria-label={deleteArm ? "Really delete?" : "Delete"}
                disabled={deleting}
                onClick={() => (deleteArm ? onDelete() : onArmDelete())}
                className={`flex h-[38px] items-center justify-center gap-1.5 rounded-full transition disabled:opacity-70 ${
                  deleteArm
                    ? "bg-red-500 px-3 text-[12px] font-medium text-white"
                    : "w-[36px] active:bg-white/15"
                }`}
              >
                {deleting ? (
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                ) : deleteArm ? (
                  "Really delete?"
                ) : (
                  <Trash2 size={16} strokeWidth={1.7} />
                )}
              </button>
            </>
          )}
          {(photo.orig_path || canDelete) && (
            <span className="h-[18px] w-px bg-white/20" />
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-[38px] w-[36px] items-center justify-center rounded-full active:bg-white/15"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* iOS only: the share sheet is coming and it isn't ours — say what to
          tap before it lands. */}
      {downloading && isIOS && (
        <div className="absolute inset-x-5 z-[3] top-[76px] rounded-2xl bg-[#1c1c1e]/70 backdrop-blur-xl px-4 py-2.5 text-xs leading-snug text-white/85">
          <strong className="font-medium text-white">Choose "Save Image"</strong>{" "}
          to put it in your camera roll.
        </div>
      )}

      {/* ARROWS — only where there's somewhere to go. Hidden behind sheets. */}
      {!sheetOpen && hasPrev && (
        <button
          type="button"
          aria-label="Previous"
          onClick={() => onStep(-1)}
          className={`${PILL} absolute left-4 top-[46%] z-[3] h-10 w-10 justify-center bg-[#1c1c1e]/50`}
        >
          <ChevronLeft size={18} strokeWidth={1.9} />
        </button>
      )}
      {!sheetOpen && hasNext && (
        <button
          type="button"
          aria-label="Next"
          onClick={() => onStep(1)}
          className={`${PILL} absolute right-4 top-[46%] z-[3] h-10 w-10 justify-center bg-[#1c1c1e]/50`}
        >
          <ChevronRight size={18} strokeWidth={1.9} />
        </button>
      )}

      {/* BOTTOM ROW — author line · reactions pill · comments pill */}
      {!sheetOpen && (
        <div
          className="absolute inset-x-0 z-[3] flex items-center justify-between gap-3 px-5"
          style={{ bottom: "max(22px, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={() => onOpenProfile?.(photo.user_id)}
            className="flex min-w-0 items-center gap-2.5 text-left"
          >
            <FriendAvatar profile={authorProfile} small />
            <span className="truncate text-[13px] text-white/85">
              <span className="font-medium text-white">
                {isMine ? "Your" : `${firstName(authorProfile)}'s`}
              </span>{" "}
              {isVideo ? "video" : "photo"} · {timeAgoShort(photo.created_at)}
            </span>
          </button>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              aria-label="Reactions"
              onClick={() => setSheet({ kind: "reactions", comment: null })}
              className={`${PILL} h-[38px] gap-1.5 pl-2.5 pr-3`}
            >
              {topEmoji.length > 0 ? (
                <span className="flex items-center">
                  {topEmoji.map((e, i) => (
                    <span
                      key={e}
                      className="w-4 text-base leading-none"
                      style={{ marginLeft: i === 0 ? 0 : -5 }}
                    >
                      {e}
                    </span>
                  ))}
                </span>
              ) : (
                <SmilePlus size={16} strokeWidth={1.6} />
              )}
              {reactionTotal > 0 && (
                <span className="text-[13.5px] font-medium tabular-nums">
                  {reactionTotal}
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label="Comments"
              onClick={() => setSheet({ kind: "comments" })}
              className={`${PILL} h-[38px] gap-1.5 px-3`}
            >
              <MessageCircle size={16} strokeWidth={1.6} />
              {commentCount > 0 && (
                <span className="text-[13.5px] font-medium tabular-nums">
                  {commentCount}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* DIM — tap to dismiss whichever sheet is up. */}
      {sheetOpen && (
        <button
          type="button"
          aria-label="Close sheet"
          onClick={() => setSheet(null)}
          className="absolute inset-0 z-[4] bg-black/50"
        />
      )}

      {/* COMMENTS SHEET */}
      {sheet?.kind === "comments" && (
        <div
          className="absolute inset-x-0 bottom-0 z-[5] flex flex-col rounded-t-3xl border-t border-white/15 bg-[#121214]/90 backdrop-blur-2xl"
          style={{ top: "42%" }}
        >
          <div className="flex shrink-0 flex-col gap-3 px-5 pt-2.5 pb-3">
            <button
              type="button"
              aria-label="Close comments"
              onClick={() => setSheet(null)}
              className="mx-auto block h-1 w-11 rounded-full bg-white/30"
            />
            <div className="flex items-center justify-between">
              <p className="text-base font-medium text-white">
                {commentCount === null
                  ? "Comments"
                  : commentCount === 1
                  ? "1 comment"
                  : `${commentCount} comments`}
              </p>
              <button
                type="button"
                aria-label="Close comments"
                onClick={() => setSheet(null)}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-white/10 active:bg-white/20"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pb-4">
            {comments === null && (
              <p className="py-1 text-xs text-white/50">Loading…</p>
            )}
            {comments !== null && comments.length === 0 && (
              <p className="py-1 text-sm text-white/50">
                No comments on this {isVideo ? "video" : "photo"} yet.
              </p>
            )}
            <div className="space-y-5">
              {(comments || []).map((c) => {
                const { counts, mine } = summarizeReactions(
                  reactions,
                  userId,
                  null,
                  c.id
                );
                const entries = Object.entries(counts);
                const cTotal = entries.reduce((s, [, n]) => s + n, 0);
                return (
                  <div key={c.id} className="flex items-start gap-2.5">
                    <button
                      type="button"
                      onClick={() => onOpenProfile?.(c.user_id)}
                      className="shrink-0"
                    >
                      <FriendAvatar profile={c.profile} small />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12.5px] text-white/55">
                        <span className="font-medium text-white/90">
                          {c.user_id === userId
                            ? "You"
                            : c.profile?.display_name || "Someone"}
                        </span>{" "}
                        · {timeAgoShort(c.created_at)}
                      </p>
                      <p className="mt-1 text-[14.5px] leading-snug text-white break-words">
                        {c.body}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {entries.map(([e, n]) => (
                          <button
                            key={e}
                            type="button"
                            disabled={reacting}
                            onClick={() => onReact(e, null, c)}
                            className={`flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-medium active:scale-90 transition disabled:opacity-50 ${
                              mine === e
                                ? "border-[#b9c6b1]/60 bg-[#b9c6b1]/20 text-[#dde6d8]"
                                : "border-white/15 bg-white/10 text-white/80"
                            }`}
                          >
                            <span className="text-sm">{e}</span> {n}
                          </button>
                        ))}
                        <button
                          type="button"
                          aria-label="Add reaction"
                          onClick={() =>
                            setSheet({ kind: "reactions", comment: c })
                          }
                          className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-white/35 text-white/70 active:scale-90 transition"
                        >
                          <Plus size={11} strokeWidth={1.8} />
                        </button>
                        {cTotal > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setSheet({ kind: "reactions", comment: c })
                            }
                            className="text-[12.5px] text-[#c3d1bb]"
                          >
                            {cTotal} reacted ›
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div
            className="shrink-0 border-t border-white/10 px-5 pt-3"
            style={{ paddingBottom: "max(14px, env(safe-area-inset-bottom))" }}
          >
            <div className="flex items-center gap-2.5">
              {/* text-base: sub-16px inputs make iOS Safari auto-zoom. */}
              <input
                ref={inputRef}
                value={commentBody}
                onChange={(e) => onCommentBodyChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSendComment()}
                placeholder={`Comment on this ${isVideo ? "video" : "photo"}`}
                maxLength={500}
                className="h-[46px] flex-1 min-w-0 rounded-full border border-white/20 bg-white/10 px-[18px] text-base text-white placeholder:text-white/60 focus:outline-none focus:border-[#b9c6b1]"
              />
              <button
                type="button"
                onClick={onSendComment}
                disabled={sending || !commentBody.trim()}
                aria-label="Send"
                className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-[#b9c6b1] text-[#2b3326] active:scale-95 transition disabled:opacity-40"
              >
                <Send size={17} strokeWidth={1.6} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REACTIONS SHEET — picker on top, who-list beneath. Scoped to the
          photo or to one comment. */}
      {sheet?.kind === "reactions" && (
        <div
          className="absolute inset-x-0 bottom-0 z-[5] flex max-h-[70%] flex-col gap-4 rounded-t-[26px] border-t border-white/15 bg-[#121214]/90 px-5 pt-3 backdrop-blur-2xl"
          style={{ paddingBottom: "max(26px, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            aria-label="Close reactions"
            onClick={() => setSheet(null)}
            className="mx-auto block h-1 w-10 shrink-0 rounded-full bg-white/30"
          />
          <div className="flex shrink-0 items-center justify-between">
            <div>
              <p className="text-[17px] font-medium text-white">Reactions</p>
              <p className="text-[13px] text-white/55">
                {sheetComment
                  ? `On ${
                      sheetComment.user_id === userId
                        ? "your"
                        : `${firstName(sheetComment.profile)}'s`
                    } comment`
                  : `On this ${isVideo ? "video" : "photo"}`}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close reactions"
              onClick={() => setSheet(null)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 active:bg-white/20"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
          <div className="flex shrink-0 justify-between border-b border-white/10 pb-4">
            {REACTION_SET.map((e) => {
              const n = sheetSummary.counts[e] || 0;
              const isMineE = sheetSummary.mine === e;
              return (
                <button
                  key={e}
                  type="button"
                  disabled={reacting}
                  onClick={() => onReact(e, sheetComment ? null : photo, sheetComment)}
                  className={`relative flex h-[46px] w-[46px] items-center justify-center rounded-full border text-[21px] active:scale-90 transition disabled:opacity-50 ${
                    isMineE
                      ? "border-[#b9c6b1] bg-[#b9c6b1]/25"
                      : "border-transparent bg-white/[0.13]"
                  }`}
                >
                  {e}
                  {n > 0 && (
                    <span
                      className={`absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[#121214] px-1 text-[10px] font-semibold ${
                        isMineE
                          ? "bg-[#b9c6b1] text-[#2b3326]"
                          : "bg-white/90 text-black"
                      }`}
                    >
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {whoRows.length === 0 ? (
              <p className="py-1 text-sm text-white/50">
                No reactions yet — tap one above.
              </p>
            ) : (
              <div className="space-y-0.5">
                {whoRows.map((r) => {
                  const p = mediaProfiles[r.user_id] || null;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onOpenProfile?.(r.user_id)}
                      className="flex w-full items-center gap-3 rounded-xl px-1 py-2 text-left active:bg-white/10"
                    >
                      <FriendAvatar profile={p} small />
                      <span className="flex-1 min-w-0 truncate text-sm text-white">
                        {r.user_id === userId
                          ? "You"
                          : p?.display_name || p?.username || "Someone"}
                      </span>
                      <span className="text-lg">{r.emoji}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
