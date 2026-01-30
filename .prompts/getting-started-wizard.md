I want to introduce a new getting started wizard that runs the first time a user opens the app, guiding them through the initial setup steps.

It should be a modal dialog that appears on first launch, with the following steps:

1. **Welcome Screen**: A brief welcome message explaining what Superagent is and what the wizard will help them set up.
2. **Configure LLM**: A step to select and configure their preferred LLM provider. Let them select provider (currently just Anthropic) and then enter their API key.
    - Validate the API key by making a test request to ensure it's correct.
    - Link to insteuctions on how to get an API key: 
            1. Sign up for an account here: https://console.anthropic.com/login
            2. After creating an account, click your Profile in the top right corner and select API Keys
            3. On the next screen, click Create Key and type in a name for your key. Hit Create Key after naming your key.
3. **Set up docker runtime**: A step to ensure they have Docker installed and running, as it's required for running agent containers.
    - Provide instructions on installing Docker if not detected.
    - Test connection to Docker daemon to ensure it's working.
4. **Set Up Composio and Connect Accounts (Optional)**: A step to connect their Composio account for OAuth integrations.
    - Allow them to enter their Composio API key.
    - Validate the key by making a test request.
    - Provide an option to skip this step and set it up later.
    - Once set up, show a list of available OAuth integrations they can connect to and let them add accounts now or later.
5. **Create First Agent (Optional)**: A step to create their first agent using a simple form.
    - Let them choose a name for the agent.
    - Provide an option to skip this step and create an agent later.

From a design perspective, we should show the step numbers up top with a progress indicator, and have "Back" and "Next" buttons to navigate between steps. The "Finish" button on the last step should complete the setup and close the wizard.

We shoulod toggle a settings flag once the wizard is completed, so it doesn't show up again on subsequent app launches.
Also add a button on the main settings page to re-run the wizard if desired. That button should close the settings page and re-open the wizard.