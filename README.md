# IntelliJ Tunnel

Remote control and monitoring for IntelliJ-based IDEs from your mobile device.

## Overview

IntelliJ Tunnel consists of two components:

- **Plugin** - An IntelliJ plugin that runs a WebSocket server inside the IDE
- **Mobile App** - A React Native (Expo) app that connects to the IDE over the local network

## Features

- **Remote Terminal** - Create and interact with terminal sessions from your phone
- **Build Monitoring** - Watch build progress and output in real-time
- **IDE Activity** - Monitor indexing, sync, and other background tasks
- **Run Configurations** - List and execute run configurations remotely
- **QR Code Pairing** - Scan a QR code to connect securely

## Project Structure

```
intellij-tunnel/
├── plugin/          # IntelliJ platform plugin (Kotlin)
└── mobile/          # React Native mobile app (Expo)
```

## Getting Started

### Plugin

1. Build the plugin:
   ```bash
   cd plugin
   ./gradlew buildPlugin
   ```

2. Install the plugin from `plugin/build/distributions/` or run in development:
   ```bash
   ./gradlew runIde
   ```

3. Open the Tunnel tool window in the IDE to see the pairing QR code.

### Mobile App

1. Install dependencies:
   ```bash
   cd mobile
   npm install
   ```

2. Start the development server:
   ```bash
   npm start
   ```

3. Scan the QR code displayed in the IDE to connect.

## Requirements

- **Plugin**: IntelliJ IDEA 2025.1+ (or compatible JetBrains IDE)
- **Mobile**: iOS 13+ or Android 10+
- Both devices must be on the same local network

## License

Proprietary
