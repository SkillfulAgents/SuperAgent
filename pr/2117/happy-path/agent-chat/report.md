[TEST_PASS]
[REASON] Opened agent QA-20261120-183748-aq0k, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains "4".
[STEP] Step 1: navigated to http://localhost:47891 — the Gamut app loaded with the sidebar listing QA-20261120-183748-aq0k (idle).
[STEP] Step 2: clicked QA-20261120-183748-aq0k in the sidebar — its agent page opened at /agents/qa-20261120-183748-aq0k-7a1z0toru3 with a composer for a new session.
[STEP] Step 3: verified status — the header status indicator reads "idle", which is an accepted state.
[STEP] Step 4: typed "Hello! What is 2+2?" into the composer and clicked Send — the view navigated to a new session ("Simple Arithmetic Question Check") with my message in the message list.
[STEP] Step 5: waited for a response — the assistant reply "2 + 2 = 4." was already present on the first check, so no wait was needed.
[STEP] Step 6: verified the response mentions "4" — it does ("2 + 2 = 4."). Took a viewport screenshot showing the user message and the reply; the header returned to "idle".
