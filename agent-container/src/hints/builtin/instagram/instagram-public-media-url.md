---
name: instagram-public-media-url
description: Points the agent to a quick tunnel when Instagram needs a public media URL
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: "*graph.instagram.com*media_type=*"
  - event: PreToolUse
    tool: Bash
    input:
      command: "*media_type=*graph.instagram.com*"
repeat: turn
---
On `graph.instagram.com`, a new post or story takes media only from a public `image_url` or `video_url`; there is no file upload. If the file is only in the workspace, serve it through a temporary Cloudflare quick tunnel.
