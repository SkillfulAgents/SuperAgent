[TEST_PASS]
[REASON] Opened the QA-20261121-001249-bmt4 agent, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains 4.
[STEP] 1. Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing QA-20261121-001249-crz0 and QA-20261121-001249-bmt4.
[STEP] 2. Clicked the QA-20261121-001249-bmt4 agent in the sidebar — the agent page opened at /agents/qa-20261121-001249-bmt4-mlzelcc073 with the agent name in the header.
[STEP] 3. Verified agent status — the header status indicator reads "idle", which satisfies the running-or-idle requirement.
[STEP] 4. Sent "Hello! What is 2+2?" — the first send click did not submit: the text stayed in the composer and no session was created. A second click on the actual "Send message" button submitted it, and the page moved to a new session at /sessions/9d89f64b-a9f7-489f-95d3-47f6de6ae358 with the message shown in the chat.
[STEP] 5. Waited for a response — the reply "2 + 2 = 4." appeared in the message list shortly after the message was sent, well within the 3-minute limit.
[STEP] 6. Verified the response mentions "4" — the assistant reply "2 + 2 = 4." is in the chat and the header still shows "idle". Screenshot taken.

The first send click was a targeting mistake on my side: I clicked a wrapper element instead of the button, which had no ref in the snapshot. It is not logged as an app bug, since the second click on the real button worked and the app behaved normally.
