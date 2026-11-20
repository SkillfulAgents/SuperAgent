[TEST_PASS]
[REASON] Sent "Hello! What is 2+2?" to agent QA-20261120-193250-s1aq and confirmed the reply contains "4".
[STEP] 1. Navigated to http://localhost:47891 — Gamut home loaded with the sidebar listing agents, including QA-20261120-193250-s1aq.
[STEP] 2. Clicked QA-20261120-193250-s1aq in the sidebar — navigated to /agents/qa-20261120-193250-s1aq-k80h2bj5cn, and the agent page header is shown.
[STEP] 3. Checked agent status — the status indicator reads "idle", which satisfies the running-or-idle requirement. Screenshot: step2-3-agent-idle.png.
[STEP] 4. Typed "Hello! What is 2+2?" into the message box and clicked Send — the session opened ("Simple Arithmetic Question Check") and the user message was shown in the chat.
[STEP] 5. Waited for the response — the reply "2 + 2 = 4." was already in the message list when checked, well within the 3-minute limit. The send button was disabled and the input cleared, with no activity indicator still shown.
[STEP] 6. Verified the response mentions "4" — it does ("2 + 2 = 4."). Screenshot: step6-response.png.
