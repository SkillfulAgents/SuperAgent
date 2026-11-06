---
name: instagram-public-media-url
description: Tells the agent once per turn, on its first Instagram call, that new media needs a public URL
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: "*instagram*"
repeat: turn
---
On `graph.instagram.com`, a new post or story takes media only from a public `image_url` or `video_url`; there is no file upload. If the file is only in the workspace, serve it through a temporary Cloudflare quick tunnel. Stop the tunnel once the container is `FINISHED` or `ERROR`.
