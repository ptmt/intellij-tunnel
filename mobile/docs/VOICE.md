# Voice Agent Research (Expo / React Native)

## Recommendation

- SDK: LiveKit React Native SDK + Expo config plugin. LiveKit has an official Expo quickstart and an Expo voice agent starter, and it is designed for WebRTC audio in React Native. It requires an Expo dev build (not Expo Go).
- LLM API: OpenAI Realtime API for low-latency speech-to-speech, or OpenAI LLM (via LiveKit Inference) if you prefer an STT -> LLM -> TTS pipeline. LiveKit Agents supports OpenAI Realtime and multiple LLM providers.

## Why LiveKit is the best fit for Expo / React Native

- LiveKit provides an Expo-specific quickstart for React Native, including the Expo config plugin and guidance on dev builds, which is the most direct path for Expo apps needing real-time audio.
- The LiveKit Voice AI starter for Expo shows end-to-end voice agent wiring on mobile.
- ElevenLabs' React Native SDK depends on LiveKit packages and also requires Expo dev builds (no Expo Go), which reinforces LiveKit as a compatible base layer for Expo apps.

## Architecture (client + agent server)

1. Mobile client (Expo / React Native)
   - Use LiveKit React Native SDK to connect to a LiveKit room via WebRTC.
   - Publish microphone audio and receive synthesized agent audio.

2. Agent server (Node or Python)
   - Run a LiveKit Agents service.
   - Configure STT, LLM, and TTS providers.
   - Define tool functions and let the agent call them (e.g., build status lookup, IDE actions, project metadata).

LiveKit Agents includes first-class LLM tool-use support. Tool calls are defined as functions on the agent and can call external services or RPC back to your app.

## LLM API selection

### Best default: OpenAI Realtime API
- Optimized for low-latency, speech-to-speech interactions.
- Supported by LiveKit Agents integrations and its OpenAI plugin.
- Works well for "agent + tools" where the server handles tool calls securely.

### Alternate: OpenAI LLM + STT/TTS pipeline
- Use LiveKit Agents with OpenAI LLM (via LiveKit Inference) plus your preferred STT/TTS.
- Easier to inspect and log intermediate text; can be cheaper depending on providers.

### Other supported LLM options (when needed)
- LiveKit Agents supports additional LLM providers via plugins, or you can use models served through LiveKit Inference.

## Compatibility notes for Expo

- Expo Go does not support native WebRTC modules; LiveKit requires a custom dev build.
- The LiveKit Expo quickstart details the required packages and config plugin setup.

## Practical next steps

1. Decide if you want speech-to-speech (OpenAI Realtime) or a pipeline (STT/LLM/TTS).
2. Stand up a small LiveKit Agents service with one tool (e.g., "getBuildStatus") and a test mobile client.
3. Integrate the LiveKit React Native SDK into the Expo app using the Expo config plugin and dev builds.

## Sources

- LiveKit Expo quickstart and voice AI starter: https://docs.livekit.io/home/quickstarts/expo/
- LiveKit Agents tool use: https://docs.livekit.io/agents/logic-structure/tools/
- LiveKit OpenAI integration (Realtime + OpenAI models): https://docs.livekit.io/agents/openai/
- LiveKit LLM overview (Inference and plugin options): https://docs.livekit.io/agents/integrations/llm/
- OpenAI Realtime API (WebRTC client guidance): https://platform.openai.com/docs/guides/realtime
- OpenAI voice agents (WebRTC vs WebSocket guidance): https://platform.openai.com/docs/guides/voice-agents
- ElevenLabs React Native SDK (LiveKit dependency and Expo dev build requirement): https://elevenlabs.io/docs/agents-platform/libraries/react-native
