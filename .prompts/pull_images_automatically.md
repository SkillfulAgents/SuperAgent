I want to improve the user experience by automatically pulling the specified agent images when the app starts, rather than waiting for the first time a user tries to run an agent that requires an image that hasn't been pulled yet.

At the container client level, we should implement two things:
- A global mechanism / singelton that indicates "readines" to run agents - so that if it isn't ready (e.g., because images are still being pulled), the "start button" for agents is disabled and shows a tooltip "Pulling agent images, please wait..." when hovered. Once the images are pulled and it's ready, the button becomes enabled and the tooltip goes away.
    - We should unify this with a mechanism to indicate lack of readiness for other reasons (e.g., docker not running, or agent runtime not available) so that we can show appropriate messages in each case.
    - Maybe the global state can be have a status enum (e.g. "RUNTIME_NOT_AVAILABLE", "PULLING_IMAGES", "READY", etc.) and an optional message field for more details. The UI can then switch on the status to determine button state and tooltip content.
    - We should implement this at the container client level so that it's not tied to a specific docker implementation and can be reused if we add other runtimes in the future.
- On app start, we check the docker image is available at the selected runtime, and if not pull it.
    - We should unify this with the existing mechanims that checks for runtime availability (e.g., docker daemon running) so that we have a single startup flow that checks for all prerequisites and updates the global readiness state accordingly.
    - We should also show some indication in the UI (e.g., a spinner or progress bar) while images are being pulled, so users understand that work is being done and the app isn't just stuck.
        - Again - UNIFY with existing UI indications for runtime availability checks, so we have a consistent experience for all startup checks.