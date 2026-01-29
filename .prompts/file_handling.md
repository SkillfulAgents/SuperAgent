I want to improve how the agent can access / interact with files.

- When creating a new session / sending a message to an agent, we should allow users to attach files
    - Dragging a file onto the chat input area should upload it and attach it to the message
    - There should also be an "Attach file" button (use a paperclip icon) next to the chat input for selecting a file from the system file picker
    - When adding attachment, we should show them under the chat input area, with a small thumbnail (if image) or icon (if other file type), filename, and a remove button (X icon)
    - We should support multiple file attachments per message
    - When sending a message with attachments, we upload the files to the agent container first (we should have a default /uploads folder in the workspace), and send the path as part of the message to the agent
- We shouls also introduce new tools allowing agents to ask for and send files:
    - "Deliver File" tool - allows the agent to send a file back to the user (agent passes file path, in the UI we show a download link for the user to download the file)
    - "Request File" tool - allows the agent to request a file from the user (agent provides a description of the file needed, in the UI we prompt the user to upload a file, once uploaded we send the file path back to the agent)
        - In the UI, we should also show a decline / decline with reason option, in which case we send back an indication to the agent that the user declined to provide the file
- In the agent container, we should have a default /uploads folder in the workspace where files are uploaded to
- We should update the system prompt to inform the agent about the new file handling
