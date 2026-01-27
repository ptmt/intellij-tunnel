import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AudioSession, LiveKitRoom, registerGlobals } from "@livekit/react-native";
import * as SecureStore from "expo-secure-store";
import { THEME } from "./theme";

registerGlobals();

type ConnectionState = "idle" | "connecting" | "connected" | "error";

type ConnectionDetails = {
  url: string;
  token: string;
};

type StoredSettings = {
  serverUrl?: string;
  tokenEndpoint?: string;
};

const STORAGE_KEY = "tunnel_voice_settings";
const TOKEN_STORAGE_KEY = "tunnel_voice_token";
const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL ?? "";
const DEFAULT_TOKEN_ENDPOINT = process.env.EXPO_PUBLIC_LIVEKIT_TOKEN_ENDPOINT ?? "";
const DEFAULT_MANUAL_TOKEN = process.env.EXPO_PUBLIC_LIVEKIT_TOKEN ?? "";

const normalizeInput = (value: string) => value.trim();

const toNonEmptyString = (value: unknown) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
};

const parseConnectionDetails = (payload: unknown, fallbackUrl: string) => {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const token =
    toNonEmptyString(data.token) ||
    toNonEmptyString(data.participantToken) ||
    toNonEmptyString(data.accessToken);
  const url =
    toNonEmptyString(data.url) ||
    toNonEmptyString(data.serverUrl) ||
    toNonEmptyString(data.wsUrl) ||
    toNonEmptyString(data.wsURL) ||
    toNonEmptyString(fallbackUrl);
  if (!token || !url) return null;
  return { token, url };
};

const readJson = (value: string) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const getErrorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unable to connect to LiveKit.";
};

export default function VoiceAssistant() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [tokenEndpoint, setTokenEndpoint] = useState(DEFAULT_TOKEN_ENDPOINT);
  const [manualToken, setManualToken] = useState(DEFAULT_MANUAL_TOKEN);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [roomUrl, setRoomUrl] = useState<string | undefined>(
    DEFAULT_SERVER_URL ? normalizeInput(DEFAULT_SERVER_URL) : undefined,
  );
  const [roomToken, setRoomToken] = useState<string | undefined>(
    DEFAULT_MANUAL_TOKEN ? normalizeInput(DEFAULT_MANUAL_TOKEN) : undefined,
  );
  const [shouldConnect, setShouldConnect] = useState(false);
  const requestIdRef = useRef(0);
  const tokenLoadedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    const loadSettings = async () => {
      try {
        const [storedSettings, storedToken] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY),
          SecureStore.getItemAsync(TOKEN_STORAGE_KEY),
        ]);
        if (!mounted) return;
        if (storedSettings) {
          const parsed = readJson(storedSettings) as StoredSettings | null;
          if (parsed?.serverUrl) {
            setServerUrl((prev) => prev || parsed.serverUrl || "");
          }
          if (parsed?.tokenEndpoint) {
            setTokenEndpoint((prev) => prev || parsed.tokenEndpoint || "");
          }
        }
        if (storedToken) {
          setManualToken(storedToken);
        }
      } catch {
        // Ignore storage errors.
      } finally {
        if (mounted) {
          tokenLoadedRef.current = true;
        }
      }
    };

    loadSettings();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      AudioSession.stopAudioSession();
    };
  }, []);

  const statusLabel = useMemo(() => {
    if (connectionState === "connected") return "Connected";
    if (connectionState === "connecting") return "Connecting";
    if (connectionState === "error") return "Error";
    return "Disconnected";
  }, [connectionState]);

  const statusColor = useMemo(() => {
    if (connectionState === "connected") return THEME.colors.success;
    if (connectionState === "connecting") return THEME.colors.warning;
    if (connectionState === "error") return THEME.colors.danger;
    return THEME.colors.muted;
  }, [connectionState]);

  const fetchConnectionDetails = useCallback(async (): Promise<ConnectionDetails> => {
    const trimmedServerUrl = normalizeInput(serverUrl);
    const trimmedEndpoint = normalizeInput(tokenEndpoint);

    if (trimmedEndpoint) {
      const response = await fetch(trimmedEndpoint);
      if (!response.ok) {
        throw new Error(`Token endpoint error (${response.status})`);
      }
      const text = await response.text();
      const parsed = readJson(text);
      const details = parseConnectionDetails(parsed, trimmedServerUrl);
      if (!details) {
        throw new Error("Token endpoint response missing token or url.");
      }
      return details;
    }

    const trimmedToken = normalizeInput(manualToken);
    if (!trimmedToken) {
      throw new Error("Provide a token endpoint or a personal token.");
    }
    if (!trimmedServerUrl) {
      throw new Error("LiveKit server URL is required.");
    }
    return { url: trimmedServerUrl, token: trimmedToken };
  }, [manualToken, serverUrl, tokenEndpoint]);

  const persistManualToken = useCallback(async (value: string) => {
    const trimmed = normalizeInput(value);
    try {
      if (!trimmed) {
        await SecureStore.deleteItemAsync(TOKEN_STORAGE_KEY);
        return;
      }
      await SecureStore.setItemAsync(TOKEN_STORAGE_KEY, trimmed, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    } catch {
      // Ignore storage errors.
    }
  }, []);

  useEffect(() => {
    if (!tokenLoadedRef.current) return;
    const handle = setTimeout(() => {
      void persistManualToken(manualToken);
    }, 400);
    return () => clearTimeout(handle);
  }, [manualToken, persistManualToken]);

  const connect = useCallback(async () => {
    if (connectionState === "connecting" || connectionState === "connected") return;
    setConnectionError(null);
    setConnectionState("connecting");
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    try {
      const details = await fetchConnectionDetails();
      if (requestIdRef.current !== requestId) return;
      setRoomUrl(details.url);
      setRoomToken(details.token);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          serverUrl: details.url,
          tokenEndpoint: normalizeInput(tokenEndpoint),
        }),
      );
      await AudioSession.startAudioSession();
      setShouldConnect(true);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setShouldConnect(false);
      setConnectionState("error");
      setConnectionError(getErrorMessage(err));
      AudioSession.stopAudioSession();
    }
  }, [connectionState, fetchConnectionDetails, tokenEndpoint]);

  const disconnect = useCallback(() => {
    requestIdRef.current += 1;
    setShouldConnect(false);
    setConnectionState("idle");
    setConnectionError(null);
    setRoomToken(undefined);
    AudioSession.stopAudioSession();
  }, []);

  const handleConnected = useCallback(() => {
    setConnectionState("connected");
  }, []);

  const handleDisconnected = useCallback(() => {
    setConnectionState("idle");
    setShouldConnect(false);
    setRoomToken(undefined);
    AudioSession.stopAudioSession();
  }, []);

  const handleError = useCallback((err: Error) => {
    setConnectionState("error");
    setConnectionError(getErrorMessage(err));
    setShouldConnect(false);
    setRoomToken(undefined);
    AudioSession.stopAudioSession();
  }, []);

  const handleMediaDeviceFailure = useCallback(() => {
    setConnectionState("error");
    setConnectionError("Microphone access failed. Check permissions.");
    setShouldConnect(false);
    setRoomToken(undefined);
    AudioSession.stopAudioSession();
  }, []);

  const connectDisabled = connectionState === "connecting" || connectionState === "connected";
  const disconnectDisabled = connectionState === "idle" && !shouldConnect;
  const inputsDisabled = connectionState === "connecting" || connectionState === "connected";

  return (
    <View style={styles.container}>
      <View style={styles.statusRow}>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <Text style={styles.statusText}>{statusLabel}</Text>
      </View>
      <Text style={styles.muted}>
        Requires an iOS/Android dev build. Provide a token endpoint that returns{" "}
        <Text style={styles.inlineCode}>{"{ token, url }"}</Text> or enter a personal token (stored
        securely on this device).
      </Text>
      <View style={styles.field}>
        <Text style={styles.label}>LiveKit server URL</Text>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="wss://your-livekit-server"
          placeholderTextColor="rgba(248, 250, 252, 0.4)"
          editable={!inputsDisabled}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Token endpoint (optional)</Text>
        <TextInput
          style={styles.input}
          value={tokenEndpoint}
          onChangeText={setTokenEndpoint}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://your-token-server"
          placeholderTextColor="rgba(248, 250, 252, 0.4)"
          editable={!inputsDisabled}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Personal token (stored in Keychain)</Text>
        <TextInput
          style={styles.input}
          value={manualToken}
          onChangeText={setManualToken}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="paste token"
          placeholderTextColor="rgba(248, 250, 252, 0.4)"
          editable={!inputsDisabled}
          secureTextEntry
        />
      </View>
      <View style={styles.buttonRow}>
        <Pressable
          style={[styles.button, styles.buttonPrimary, connectDisabled && styles.buttonDisabled]}
          onPress={connect}
          disabled={connectDisabled}
        >
          {connectionState === "connecting" ? (
            <View style={styles.buttonContent}>
              <ActivityIndicator size="small" color={THEME.colors.text} />
              <Text style={styles.buttonText}>Connecting...</Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonSecondary, disconnectDisabled && styles.buttonDisabled]}
          onPress={disconnect}
          disabled={disconnectDisabled}
        >
          <Text style={styles.buttonText}>Disconnect</Text>
        </Pressable>
      </View>
      {connectionError ? <Text style={styles.errorText}>{connectionError}</Text> : null}
      {roomUrl && roomToken ? (
        <LiveKitRoom
          serverUrl={roomUrl}
          token={roomToken}
          connect={shouldConnect}
          audio={true}
          video={false}
          onConnected={handleConnected}
          onDisconnected={handleDisconnected}
          onError={handleError}
          onMediaDeviceFailure={handleMediaDeviceFailure}
        >
          <View />
        </LiveKitRoom>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 13,
  },
  muted: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  inlineCode: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
  },
  field: {
    gap: 6,
  },
  label: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.muted,
    fontSize: 12,
  },
  input: {
    backgroundColor: THEME.colors.input,
    color: THEME.colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    fontFamily: "SpaceGrotesk_500Medium",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  buttonPrimary: {
    backgroundColor: THEME.colors.primary,
  },
  buttonSecondary: {
    backgroundColor: "rgba(148, 163, 184, 0.2)",
    borderColor: "rgba(148, 163, 184, 0.4)",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 13,
  },
  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  errorText: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.danger,
    fontSize: 12,
  },
});
