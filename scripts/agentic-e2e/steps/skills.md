# Skills Steps

## install-skill

On the agent landing page, scroll down to find the discoverable skills section (cards showing available skills).
Look for a skill that does NOT require environment variables — good choices are skills with a simple "Install" button and no env var form.
For example, look for "Amazon Order" or any skill that shows a simple install button.
Click the install (+) button on the skill card.
If an env var dialog appears and you don't have the required values, click Cancel, pick a different skill, and try again.
Take a screenshot after installation.
Assert: the skill appears in the agent's installed skills list with status "Up to date".
DO NOT skip this step — keep trying different skills until one installs successfully.

---

## verify-skill-installed

Open the agent settings dialog and click the "Skills" tab.
Take a screenshot.
Assert: at least one skill is listed with status "Up to date" or "locally-modified".

---

## update-skill

In the agent settings "Skills" tab, check if any skill shows status "update-available".
If yes, click its "Update" button and take a screenshot.
If no skills have updates available, note "no updates available" — this is acceptable.
Assert: if updated, the skill status changes to "Up to date".
