[TEST_PASS]
[REASON] Opened agent QA-20261120-215821-f42s, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains "4".
[STEP] 1. Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing QA-20261120-215822-6jmg and QA-20261120-215821-f42s.
[STEP] 2. Clicked the QA-20261120-215821-f42s agent in the sidebar — its agent page opened at /agents/qa-20261120-215821-f42s-1s0x48ergj (screenshot step1-navigate.png).
[STEP] 3. Verified status — the header and sidebar both show "idle", which satisfies the running-or-idle requirement.
[STEP] 4. Typed "Hello! What is 2+2?" into the message box and clicked Send — the app opened a new session (Basic Arithmetic Greeting) and the message appeared in the chat (screenshot step4-message-sent.png).
[STEP] 5. Waited for a response — the reply "2 + 2 = 4." was already rendered on the first check after sending, so no wait was needed.
[STEP] 6. Verified the response mentions "4" — it reads "2 + 2 = 4." The screenshot step4-message-sent.png shows the user message and the reply.

Minor observation (not counted as a bug): right after sending, the session header breadcrumb read "New Session" while the sidebar already showed the session as "Basic Arithmetic Greeting". This may just be a title that hadn't refreshed yet; I did not re-check it.
