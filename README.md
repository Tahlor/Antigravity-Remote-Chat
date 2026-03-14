# Antigravity Shit-Chat Mobile Monitor & Toolkit

Need to go to the bathroom? But Opus 4.5 might be done with that big task soon? Want to eat lunch? But there's more tokens left before they reset right after lunch?

<img width="1957" height="1060" alt="screenshot" src="https://github.com/user-attachments/assets/95318065-d943-43f1-b05c-26fd7c0733dd" />


A real-time mobile interface for monitoring and interacting with Antigravity chat sessions. 

## Integrated Toolkit (Dashboard & Auto-Accept)

We have synthesized two external atomic features directly into this application. Both are implemented entirely natively inside this repo (no external dependencies, fully safe, independent, and audited for malicious code). 

- **Auto-Accept Agent:** Automatically clicks "accept", "run", and "apply" prompts for the AI agent, allowing true hands-free operation. This is done by injecting a safe client-side script (`scripts/auto-accept.js`) directly into the IDE via CDP. Sourced directly from [antigravity-auto-accept](https://github.com/pesoszpesosz/antigravity-auto-accept).
- **Quota & Cache Dashboard:** A new Dashboard tab displays your token allowances and local cache footprint in real time. The server uses local child processes and local APIs to securely fetch your quota without relying on external domains, mimicking the behavior of [antigravity-dashboard](https://github.com/nextcortex/antigravity-dashboard).

## How It Works

It's a simple system, but pretty hacky.

The mobile monitor operates through three main components:

### 1. Reading (Snapshot Capture)
The server connects to Antigravity via Chrome DevTools Protocol (CDP) and periodically captures **snapshots of the chat interface**:
- Captures all CSS styles to preserve formatting, sends CSS only once bc its huge
- Captures the HTML of the chat interface
- Buttons and everything that you wont be able to click
- Polls every 3 seconds and only updates when content changes

### 2. Injecting (Message Sending)
Antigravity must be run in chrome with remote debugging enabled.
Messages typed in the mobile interface are injected directly into Antigravity:
- Locates the Antigravity chat input editor
- Inserts the message text and triggers submission
- Handles the input safely without interfering with ongoing operations

### 3. Serving (Web Interface)
A lightweight web server provides the mobile UI:
- WebSocket connection for real-time updates
- Auto-refresh when new content appears
- Send messages directly from your phone

## Setup & Deployment

You can run this project locally, or install it globally as a command-line tool on your computer.

### Recommended: 1-Step Global Install (from Git)

To install this tool globally directly from the repository so you can run it anywhere:

```bash
npm install -g git+https://github.com/Taylor/Antigravity-Remote-Chat.git
```
*(Replace the URL with your actual remote repository URL when pushed)*

Once installed, you can start the monitor from anywhere just by typing:
```bash
ag-monitor
```

### Manual Setup (Development)

1. Start Antigravity with Chrome DevTools Protocol enabled:
```bash
antigravity . --remote-debugging-port=9000
```
*(You will get this message: "Warning: 'remote-debugging-port' is not in the list of known options, but still passed to Electron/Chromium." that's fine)*

2. Clone and Install Dependencies
```bash
npm install
```

3. Start the Monitor
```bash
npm start
```

### Accessing the Dashboard

Open your browser in the bathroom and navigate to:
```
http://<your-local-ip>:3000
```

### Problems?

Problems setting up? Don't know how to do a step? Can't find an explanation? **Open Shit-Chat folder in antigravity and tell the agent what issues you are having**. It can read the code in one go.

------------

This is over local network, so it will not work if you are on a different network, unless you use a VPN or tailscale or something.

I have tried keeping it simple and not adding any extra features, but if you want to add more features, feel free to do so, because of how simple it is it should be pretty easy. You might just want to use the server.js and just use the API it exposes to interact with open chatwindows with your own client.

### Thanks to https://github.com/lukasz-wronski for finding bugs and https://github.com/Mario4272 for the original idea. 
