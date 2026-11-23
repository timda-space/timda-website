// Hub policy: the choices TIMDA leaves to each hub, all in one place.
//
// Not here, on purpose:
//   - Protocol rules (statement sizes, freshness, nonce lifetimes, how long mail is
//     kept). They sit next to the code that enforces them, with their spec sections,
//     because a hub that changed them wouldn't be speaking TIMDA any more.
//   - Per-deployment values and secrets (HUB_DOMAIN, bindings), which are set in the
//     Cloudflare dashboard so staging and production can differ.

export const CONFIG = {
  docking: {
    review: true,        // new Sections wait for a Board resolution before they're listed
  },
  arrivalsBoard: {
    kept: 50,            // announcements kept (and in the feed)
    shown: 6,            // shown on the Arrivals page
  },
  lounge: {
    rotateSeconds: 60,   // banner rotation, by Refresh header
  },
  mail: {
    listedOnly: true,    // carry mail only between Sections listed here (and the hub itself)
    perSenderPerDay: 20, // messages a Section may send in a day (UTC)
    perInbox: 100,       // messages held for one Section at a time
  },
};
