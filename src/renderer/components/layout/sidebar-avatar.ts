// Agent-row avatar, px across, in a 40px row that holds the name and its
// last-run line. It sits centred in a 32px slot at left 4px, so its centre is
// x=20: the sessions sub-list is padded 25px to land its tree connector
// (drawn 5px left of each item) there. An empty section's ghost row uses the
// same slot, so it lines up with the rows that will replace it.
export const AGENT_AVATAR_SIZE = 27

// The avatar's left edge in its row. The footer starts the user's avatar here
// too, so the two line up down the sidebar.
export const AGENT_AVATAR_LEFT = 4 + (32 - AGENT_AVATAR_SIZE) / 2

// Avatars follow the cursor while it's over the sidebar, and go back to their
// own motion (an orb's wander, its look at the viewer) when it leaves.
export const SIDEBAR_FOLLOW_REGION = '[data-sidebar="sidebar"]'
