I want to add a feature notifying users at appropriate times using local notifications. Generally, we send three notifications:
- An agent has finished running (session complete)
- An agent is waiting for user input (session waiting - user action needed like providing access / answering a question) 
- An agent has been triggered (session started) by a schedule

We only want to send notifications about sessions the user is not currently viewing, to avoid redundant notifications. (So if I am viewing the session in the app, I don't need a notification about it.)

We shall present notifications in several ways:
- We should have a DB table storing notifications, and show a little notification badge in the app UI when there are unread notifications (opens a dropdown with recent notifications, clicking a notification takes you to the relevant session)
    - When we view the agent session, we mark related notifications as read automatically.
- We should send local notifications to the OS (so they appear in the notification center, and as banners, etc. depending on user settings)
    - We must ensure this works on web (using the Notifications API), and in the electron app (using the Electron Notifications API).
- Settings - there'll be a setting to toggle notifications on/off globally, and per-notification-type (session complete, session waiting, session started).

