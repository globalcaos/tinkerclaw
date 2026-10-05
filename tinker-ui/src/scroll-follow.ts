// FORK 2026-09-29 (the architect: "After sending a prompt, the chat should scroll down so one can see
// the prompt introduced in the chat and the chat scrolls with the response after that.")
//
// The chat's follow flag (`chatFollow` in app.ts) is LATCHED INTENT (bible §5.20, reworked
// 2026-09-06): follow only while the user has parked at the bottom, recomputed exclusively on
// real gestures. That latch had no re-arm on the owner's own send: type while parked anywhere
// but within FOLLOW_BOTTOM_EPS of the bottom and the new user bubble was drawn OFF-SCREEN,
// with the response streaming invisibly under it. Sending a prompt is the strongest possible
// statement of intent — "I am at the conversation's leading edge now" — so it re-arms follow
// exactly like a gesture that parks at the bottom would.
//
// This module is the ONE decision table for the latch. app.ts owns the DOM (which event
// happened); this module owns the verdict:
//   - 'owner-send'          → follow ON. ONLY the owner's own composer send (Enter / send
//                             button — send()'s `fromComposer` flag). Ladder retries, explicit
//                             Resend, the COMPACT button's CLI turn, send("/new"), steers from
//                             other tabs and history loads must not fabricate this event.
//   - 'user-scroll'         → an actual gesture (wheel/touch/keyboard/scrollbar drag): follow
//                             is re-derived from where the gesture LANDED. `byGesture: false`
//                             marks a scroll event the caller cannot rule out as an echo of
//                             its own write — those never change intent.
//   - 'content-grew'        → a streaming delta / image load: never changes intent.
//   - 'programmatic-scroll' → our own setChatScrollTop write: never changes intent. (app.ts
//                             filters these before the listener body via isProgrammaticEcho,
//                             so its early-return IS this event; the type exists so the
//                             invariant is stated — and tested — as algebra, not prose.)
//   FORK 2026-10-02 (chat-viewport.ts — the latch became PER TAB, plus three user actions that
//   are gestures although no scroll event announces them):
//   - 'user-toggle'         → the owner opened or closed a fold (a tool row, a <summary>):
//                             re-derived from where the viewport lands, exactly like a scroll
//                             gesture. Opening a row above the bottom pushes the last line out of
//                             view, so the stream stops dragging him away from what he opened.
//   - 'user-navigate'       → a jump to an older point (EEG prompt click, timeline click): follow
//                             OFF before the jump starts, or the next delta pins the bottom and
//                             cancels the smooth scroll mid-flight.
//   - 'tab-enter'           → the tab coming on screen restores its OWN remembered latch.
//   - 'anchor-lost'         → the row a tab remembered cannot be found (paged out of reach, a
//                             reset): show the latest row and follow it.
//
// KNOWN COUPLINGS the latch carries beyond the viewport (deliberate, not free):
//   - Transcript trimming: viewedTrimCutoff(…, chatFollow) trims the viewed page only while
//     the owner is pinned to the latest row (app.ts ~12333). An owner-send re-arm therefore
//     re-ENABLES trimming of older paged-in rows once the turn ends — coherent, because
//     sending parks the owner at the latest row, the same place a re-arming gesture would;
//     R12 pages trimmed rows back in on the next scroll-up.
//   - Hole fill: an owed fill waits while pinned (app.ts ~12814, ~4570); a re-arm puts it
//     back to waiting, exactly as a gesture to the bottom would.
//   - The latch is PER TAB since 2026-10-02 (it was page-global, which is what opened a tab in
//     the middle of its conversation): saveCurrentTabState stores the tab's memory, loadTabState
//     applies 'tab-enter', and a reload restores it from ui-state (chat-viewport.ts).
//   - The idle background stub (trimIdleBackgroundTabs) skips a tab left reading, the same rule
//     the viewed trim follows while this latch is off.

export interface FollowState {
  /** True while the viewport should stick to the newest row. */
  follow: boolean;
}

export type FollowEvent =
  | { type: "owner-send" }
  | { type: "user-scroll"; distanceFromBottom: number; byGesture: boolean }
  | { type: "content-grew" }
  | { type: "programmatic-scroll" }
  | { type: "user-toggle"; distanceFromBottom: number }
  | { type: "user-navigate" }
  | { type: "tab-enter"; remembered: boolean }
  | { type: "anchor-lost" };

/**
 * Intent, not proximity — deliberately 2, not 80. A gesture re-arms follow only when it PARKS
 * at the bottom; the old 80px threshold manufactured false "at bottom" reads while the
 * composer autosized (the 2026-09-06 latched-intent rewrite in app.ts). This is the ONE copy
 * of the number: app.ts's BOTTOM_EPS is an alias of it.
 */
export const FOLLOW_BOTTOM_EPS = 2;

/** Pure latch transition: events that do not change the state return the SAME object. */
export function nextFollowState(
  state: FollowState,
  event: FollowEvent,
  eps: number = FOLLOW_BOTTOM_EPS,
): FollowState {
  switch (event.type) {
    case "owner-send":
      return state.follow ? state : { follow: true };
    case "user-scroll": {
      if (!event.byGesture) {
        return state; // possibly an echo of our own write — never a statement of intent
      }
      const follow = event.distanceFromBottom <= eps;
      return follow === state.follow ? state : { follow };
    }
    case "user-toggle": {
      const follow = event.distanceFromBottom <= eps;
      return follow === state.follow ? state : { follow };
    }
    case "user-navigate":
      return state.follow ? { follow: false } : state;
    case "tab-enter":
      return event.remembered === state.follow ? state : { follow: event.remembered };
    case "anchor-lost":
      return state.follow ? state : { follow: true };
    case "content-grew":
    case "programmatic-scroll":
      return state;
  }
}
