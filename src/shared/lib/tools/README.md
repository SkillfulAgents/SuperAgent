# Tools and input requests

Each tool folder owns its `definition.ts` (shared name, input summary, and request
notification text and voice description), `renderer.tsx` (transcript view), and, where applicable,
`request.tsx` (interactive card). Tests live beside the code they cover. Requests
without a tool call, such as API reviews and reauthentication, have their own
definition and card folders too.

- `registry.ts` is the backend-safe entry point for tool names, aliases, and
  request metadata. The request index is derived from each definition's `kind`,
  including standalone requests. It never imports React components.
- `renderers.ts` binds transcript views to those definition objects. It does not
  repeat the tool-name or alias map.
- `requests/pending-request-renderer.tsx` binds every request kind to its card;
  the mapped type checks the props for each kind.
- `requests/` holds the request schema, lifecycle stores, pending-request
  projection, and common card controls. `ui/` holds transcript view helpers.

Add presentation metadata in the tool's definition and consume it through the
registry. Import React entry points only from renderer code. Registry tests check
coverage and enforce that backend metadata can load without React.

Request kind selects dispatch, transcript recovery, and pending-card projection.
Backend handlers stay in the persister. `syncsAwaitingItself` excludes conditional
approvals from automatic waiting/recovery; `hideToolStatusInChat` suppresses chat
status lines independently (file delivery uses it without creating a request).
`showWaitingForInput` preserves transcript labels separately from actual blocking.
The registry retains the existing namespace fallback for generic user-input tools.
