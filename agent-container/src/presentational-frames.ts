/**
 * Frames marked role="none" or role="presentation".
 *
 * Chrome reports such a frame as `IframePresentational` rather than `Iframe`,
 * and still exposes the document inside it: a presentational role takes away
 * the element's own semantics, not its content's. agent-browser gives a ref
 * to, and reads into, only the `Iframe` role (0.39.1, unchanged through
 * 0.41.0), so a frame marked that way showed in no tree and its fields had no
 * refs. Apple's sign-in frame is one (App Store Connect, developer.apple.com):
 * request_login had no refs to map, and the agent handed the browser to the
 * user.
 *
 * The page observer counts these frames (`presentationalFrames`). While it
 * counts any, the role is dropped from them before a tree read, and the tree
 * then reads into them like any other frame. Remove this once agent-browser
 * treats both roles alike (vercel-labs/agent-browser#1831).
 */

/** Frames whose role makes Chrome report them as `IframePresentational`. */
export const PRESENTATIONAL_FRAME_SELECTOR = 'iframe[role="none" i],iframe[role="presentation" i]'

/** Drop the role from the page's presentational frames. Returns how many it changed. */
export const CLEAR_PRESENTATIONAL_ROLE_SCRIPT =
  '(function(){var n=0;try{var fs=document.querySelectorAll(' + JSON.stringify(PRESENTATIONAL_FRAME_SELECTOR) + ');' +
  'for(var i=0;i<fs.length;i++){fs[i].removeAttribute("role");n++}}catch(e){}return n})()'
