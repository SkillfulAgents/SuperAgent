Have an idle-timeout for containers running in the background, so that if they are not being used for a certain period of time, they automatically go to sleep mode (basically stop the container).

We should make the timeout period configureable in the app settings (default to 30 mins).

We already support starting/stopping containers manually from the UI, so this would be an additional automatic mechanism to stop containers that are not being used.