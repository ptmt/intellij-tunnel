import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold, useFonts } from "@expo-google-fonts/space-grotesk";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  Platform,
  AppState,
  Modal,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Animated,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextStyle,
  TextInput,
  View,
} from "react-native";
import useAudioTranscription from "./useAudioTranscription";
import VoiceAssistant from "./VoiceAssistant";
import { THEME } from "./theme";

type ConnectionState = "disconnected" | "connecting" | "connected";

type TerminalSession = {
  id: string;
  name: string;
  workingDirectory: string;
  createdAt: string;
};

type TerminalStyleRun = {
  start: number;
  end: number;
  fg?: string | null;
  bg?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

type RunConfigurationItem = {
  id: string;
  name: string;
  type: string;
  folder?: string | null;
  temporary?: boolean;
  shared?: boolean;
};

type IdeProgressTask = {
  id: string;
  kind: "indexing" | "build" | "sync";
  title: string;
  text?: string | null;
  fraction?: number | null;
  indeterminate?: boolean;
  projectName?: string | null;
  startedAt?: string | null;
};

type ConnectionHistoryItem = {
  id: string;
  serverUrl: string;
  pairingToken: string;
  lastUsed: string;
};

type AppTab = "terminal" | "builds" | "assistant" | "activity";

type ServerMessage =
  | { type: "hello_ack"; deviceId: string }
  | { type: "approval_required"; message?: string }
  | { type: "approval_pending"; message?: string }
  | { type: "approval_granted"; deviceId?: string }
  | { type: "approval_denied"; message?: string }
  | { type: "sessions"; items: TerminalSession[] }
  | { type: "terminal_started"; session: TerminalSession }
  | {
      type: "terminal_output";
      sessionId: string;
      output: string;
      cursorOffset?: number;
      styles?: TerminalStyleRun[];
    }
  | { type: "terminal_closed"; sessionId: string }
  | { type: "terminal_error"; message: string }
  | { type: "ide_progress"; tasks: IdeProgressTask[] }
  | { type: "build_status"; status: string; message?: string }
  | {
      type: "build_output";
      buildId: string;
      title?: string | null;
      text: string;
      level?: string | null;
      projectName?: string | null;
    }
  | { type: "run_configurations"; items: RunConfigurationItem[] }
  | { type: "run_configuration_status"; status: string; id: string; name?: string; message?: string }
  | {
      type: "run_output";
      runId: string;
      name?: string | null;
      text: string;
      stream?: string | null;
      projectName?: string | null;
      configId?: string | null;
      executorId?: string | null;
    }
  | { type: "error"; message?: string; code?: string };

const initialServerUrl = "ws://localhost:8765/ws";
const SESSION_POLL_MS = 6000;
const HISTORY_LIMIT = 6;
const LOG_LIMIT = 200;
const STORAGE_KEYS = {
  serverUrl: "tunnel_server_url",
  pairingToken: "tunnel_pairing_token",
  sessions: "tunnel_sessions",
  activeSession: "tunnel_active_session",
  connectionHistory: "tunnel_connection_history",
  terminalOutputs: "tunnel_terminal_outputs",
};

const formatPercent = (value: number | null | undefined) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "0%";
  return `${Math.round(value * 100)}%`;
};

export default function App() {
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
  });
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [pairingToken, setPairingToken] = useState<string>("");
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [connectionHistory, setConnectionHistory] = useState<ConnectionHistoryItem[]>([]);
  const [connectionModalVisible, setConnectionModalVisible] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [reconnectPending, setReconnectPending] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("terminal");
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [terminalOutputs, setTerminalOutputs] = useState<Record<string, string>>({});
  const [terminalCursorOffsets, setTerminalCursorOffsets] = useState<Record<string, number | null>>({});
  const [terminalOutputStyles, setTerminalOutputStyles] = useState<
    Record<string, TerminalStyleRun[] | null>
  >({});
  const [quickKeysPinned, setQuickKeysPinned] = useState(false);
  const [command, setCommand] = useState<string>("");
  const [buildStatus, setBuildStatus] = useState<string>("idle");
  const [ideProgress, setIdeProgress] = useState<IdeProgressTask[]>([]);
  const [runConfigurations, setRunConfigurations] = useState<RunConfigurationItem[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const transcription = useAudioTranscription();
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const shouldResumeReconnectRef = useRef(false);
  const reconnectBlockedRef = useRef<string | null>(null);
  const blockedTokenRef = useRef<string | null>(null);
  const blockNotifiedRef = useRef(false);
  const pendingSendsRef = useRef<Record<string, unknown>[]>([]);
  const scanLockRef = useRef(false);
  const scanResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputScrollRef = useRef<ScrollView | null>(null);
  const transcriptionBaseRef = useRef("");
  const autoScrollEnabledRef = useRef(true);
  const outputContentHeightRef = useRef(0);
  const outputLayoutHeightRef = useRef(0);
  const connectionRef = useRef<ConnectionState>("disconnected");
  const serverUrlRef = useRef(serverUrl);
  const pairingTokenRef = useRef(pairingToken);
  const statusPulse = useRef(new Animated.Value(0)).current;
  const statusPulseAnimationRef = useRef<Animated.CompositeAnimation | null>(null);
  const invalidTokenHandledRef = useRef(false);
  const autoConnectAttemptedRef = useRef(false);
  const clientIdRef = useRef<string | null>(null);
  const subscribedSessionRef = useRef<string | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const settingsLoadedRef = useRef(false);

  const isConnectingStatus = connection === "connecting" || (reconnectPending && connection !== "connected");
  const statusLabel = useMemo(() => {
    if (connection === "connected") return "Connected";
    if (isConnectingStatus) return "Connecting";
    return "Disconnected";
  }, [connection, isConnectingStatus]);

  const statusColor = useMemo(() => {
    if (connection === "connected") return THEME.colors.success;
    if (isConnectingStatus) return THEME.colors.warning;
    return THEME.colors.danger;
  }, [connection, isConnectingStatus]);

  useEffect(() => {
    if (isConnectingStatus) {
      statusPulse.setValue(0);
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(statusPulse, {
            toValue: 1,
            duration: 900,
            useNativeDriver: true,
          }),
          Animated.timing(statusPulse, {
            toValue: 0,
            duration: 900,
            useNativeDriver: true,
          }),
        ]),
      );
      statusPulseAnimationRef.current = animation;
      animation.start();
    } else {
      statusPulseAnimationRef.current?.stop();
      statusPulseAnimationRef.current = null;
      statusPulse.setValue(0);
    }
  }, [isConnectingStatus, statusPulse]);

  const buildHistoryId = (url: string) => normalizeUrl(url).trim();
  const shouldForceConnectionModal =
    settingsReady && connectionHistory.length === 0 && connection !== "connected";
  const connectionModalOpen =
    (connectionModalVisible || shouldForceConnectionModal) && !scannerVisible;
  const formatLastUsed = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getTime() <= 0) {
      return "Last used: never";
    }
    const stamp = date.toISOString().slice(0, 16).replace("T", " ");
    return `Last used: ${stamp}Z`;
  };
  const canInteract = connection === "connected";
  const hasCachedSessions = sessions.length > 0;
  const showCachedContent = connection === "disconnected" && hasCachedSessions;
  const isLoading = connection === "connecting" || (canInteract && !sessionsLoaded);
  const pulsingStatusStyle = isConnectingStatus
    ? {
        opacity: statusPulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
        transform: [
          {
            scale: statusPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }),
          },
        ],
      }
    : null;

  const transcriptionText = useMemo(() => {
    if (transcription.committedText && transcription.partialText) {
      return `${transcription.committedText} ${transcription.partialText}`;
    }
    return transcription.committedText || transcription.partialText;
  }, [transcription.committedText, transcription.partialText]);

  useEffect(() => {
    if (transcription.isRecording) {
      transcriptionBaseRef.current = command.trim();
      return;
    }
    transcriptionBaseRef.current = "";
  }, [transcription.isRecording]);

  useEffect(() => {
    if (!transcription.isRecording) return;
    const base = transcriptionBaseRef.current;
    const next = base
      ? transcriptionText
        ? `${base} ${transcriptionText}`
        : base
      : transcriptionText;
    if (next !== command) {
      setCommand(next);
    }
  }, [transcription.isRecording, transcriptionText]);

  const pushLog = (entry: string) => {
    setLogs((prev) => [entry, ...prev].slice(0, LOG_LIMIT));
  };

  const appendOutputLines = (
    source: "Build" | "Run",
    title: string | null | undefined,
    text: string,
    level: string | null | undefined,
    projectName: string | null | undefined,
  ) => {
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    const labelParts = [source, title?.trim()].filter(Boolean) as string[];
    let label = labelParts.join(" ");
    if (projectName?.trim()) {
      label = `${label} (${projectName.trim()})`;
    }
    const tag = level && level !== "stdout" ? ` [${level}]` : "";
    const entries = lines.map((line) => `${label}${tag}: ${line}`);
    setLogs((prev) => {
      const additions = [...entries].reverse();
      return [...additions, ...prev].slice(0, LOG_LIMIT);
    });
  };

  const describePayloadType = (payload: Record<string, unknown>) => {
    const type = payload.type;
    return typeof type === "string" ? type : "unknown";
  };

  const logOutbound = (payload: Record<string, unknown>, queued: boolean) => {
    const type = describePayloadType(payload);
    pushLog(queued ? `queued ${type}` : `ws => ${type}`);
  };

  const logInbound = (message: ServerMessage) => {
    if (message.type === "build_output" || message.type === "run_output") {
      return;
    }
    if (message.type === "hello_ack") {
      pushLog(`ws <= hello_ack (${message.deviceId.slice(0, 6)})`);
      return;
    }
    if (message.type === "approval_required") {
      pushLog("ws <= approval_required");
      return;
    }
    if (message.type === "approval_pending") {
      pushLog("ws <= approval_pending");
      return;
    }
    if (message.type === "approval_granted") {
      pushLog("ws <= approval_granted");
      return;
    }
    if (message.type === "approval_denied") {
      pushLog("ws <= approval_denied");
      return;
    }
    if (message.type === "sessions") {
      pushLog(`ws <= sessions (${message.items.length})`);
      return;
    }
    if (message.type === "terminal_output") {
      pushLog(`ws <= terminal_output (${message.output.length} chars)`);
      return;
    }
    if (message.type === "terminal_closed") {
      pushLog(`ws <= terminal_closed (${message.sessionId.slice(0, 6)})`);
      return;
    }
    if (message.type === "build_status") {
      pushLog(`ws <= build_status (${message.status})`);
      return;
    }
    if (message.type === "run_configurations") {
      pushLog(`ws <= run_configurations (${message.items.length})`);
      return;
    }
    if (message.type === "run_configuration_status") {
      pushLog(`ws <= run_configuration_status (${message.status})`);
      return;
    }
    pushLog(`ws <= ${message.type}`);
  };

  const updateConnection = (next: ConnectionState) => {
    connectionRef.current = next;
    setConnection(next);
  };

  useEffect(() => {
    if (scannerVisible) return;
    if (scanResetTimerRef.current) {
      clearTimeout(scanResetTimerRef.current);
      scanResetTimerRef.current = null;
    }
    scanLockRef.current = false;
    setScanError(null);
  }, [scannerVisible]);

  useEffect(() => {
    return () => {
      if (scanResetTimerRef.current) {
        clearTimeout(scanResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const previous = serverUrlRef.current;
    serverUrlRef.current = serverUrl;
    if (settingsLoadedRef.current) {
      const trimmed = serverUrl.trim();
      if (!trimmed) {
        AsyncStorage.removeItem(STORAGE_KEYS.serverUrl).catch(() => {
          // Ignore storage errors.
        });
      } else {
        AsyncStorage.setItem(STORAGE_KEYS.serverUrl, trimmed).catch(() => {
          // Ignore storage errors.
        });
      }
    }
    if (reconnectBlockedRef.current && previous !== serverUrl) {
      reconnectBlockedRef.current = null;
      blockedTokenRef.current = null;
      blockNotifiedRef.current = false;
      pushLog("Server updated. Reconnect enabled.");
      if (shouldResumeReconnectRef.current) {
        shouldReconnectRef.current = true;
        shouldResumeReconnectRef.current = false;
        scheduleReconnect();
      }
    }
    if (previous !== serverUrl) {
      reconnectAttemptsRef.current = 0;
    }
  }, [serverUrl]);

  useEffect(() => {
    const previous = pairingTokenRef.current;
    pairingTokenRef.current = pairingToken;
    if (settingsLoadedRef.current) {
      const trimmed = pairingToken.trim();
      if (!trimmed) {
        AsyncStorage.removeItem(STORAGE_KEYS.pairingToken).catch(() => {
          // Ignore storage errors.
        });
      } else {
        AsyncStorage.setItem(STORAGE_KEYS.pairingToken, trimmed).catch(() => {
          // Ignore storage errors.
        });
      }
    }
    if (
      reconnectBlockedRef.current &&
      blockedTokenRef.current !== null &&
      pairingToken.trim() &&
      pairingToken.trim() !== blockedTokenRef.current
    ) {
      reconnectBlockedRef.current = null;
      blockedTokenRef.current = null;
      blockNotifiedRef.current = false;
      pushLog("Token updated. Reconnect enabled.");
      if (shouldResumeReconnectRef.current) {
        shouldReconnectRef.current = true;
        shouldResumeReconnectRef.current = false;
        scheduleReconnect();
      }
    }
    if (previous !== pairingToken) {
      reconnectAttemptsRef.current = 0;
    }
  }, [pairingToken]);

  useEffect(() => {
    clientIdRef.current = clientId;
  }, [clientId]);

  useEffect(() => {
    if (connection === "connected") {
      setConnectionModalVisible(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!settingsReady) return;
    if (autoConnectAttemptedRef.current) return;
    if (connectionRef.current !== "disconnected") return;
    if (connectionHistory.length === 0) return;
    autoConnectAttemptedRef.current = true;
    connectWithHistory(connectionHistory[0]);
  }, [connectionHistory, settingsReady]);

  useEffect(() => {
    let active = true;
    const loadSettings = async () => {
      const entries = await AsyncStorage.multiGet([
        STORAGE_KEYS.serverUrl,
        STORAGE_KEYS.pairingToken,
        STORAGE_KEYS.sessions,
        STORAGE_KEYS.activeSession,
        STORAGE_KEYS.connectionHistory,
        STORAGE_KEYS.terminalOutputs,
      ]);
      if (!active) return;
      const stored = Object.fromEntries(entries);
      settingsLoadedRef.current = true;
      if (active) {
        setSettingsReady(true);
      }
      const storedUrl = stored[STORAGE_KEYS.serverUrl];
      if (storedUrl) {
        setServerUrl(storedUrl);
      }
      const storedToken = stored[STORAGE_KEYS.pairingToken];
      if (storedToken) {
        setPairingToken(storedToken);
      }
      const storedSessions = stored[STORAGE_KEYS.sessions];
      if (storedSessions) {
        try {
          const parsed = JSON.parse(storedSessions);
          if (Array.isArray(parsed)) {
            const safeSessions = parsed.filter(
              (item) =>
                item &&
                typeof item.id === "string" &&
                typeof item.name === "string" &&
                typeof item.workingDirectory === "string" &&
                typeof item.createdAt === "string",
            );
            if (active) {
              setSessions(safeSessions);
            }
          }
        } catch {
          // Ignore invalid cached sessions.
        }
      }
      const storedActive = stored[STORAGE_KEYS.activeSession];
      if (storedActive) {
        setActiveSessionId(storedActive);
      }
      const storedHistory = stored[STORAGE_KEYS.connectionHistory];
      if (storedHistory) {
        try {
          const parsed = JSON.parse(storedHistory);
          if (Array.isArray(parsed)) {
            const safeHistory = parsed
              .map((item) => {
                if (!item || typeof item.serverUrl !== "string" || typeof item.pairingToken !== "string") {
                  return null;
                }
                const url = item.serverUrl.trim();
                const token = item.pairingToken.trim();
                if (!url || !token) return null;
                const lastUsed = typeof item.lastUsed === "string" ? item.lastUsed : new Date(0).toISOString();
                const id = buildHistoryId(url);
                return {
                  id,
                  serverUrl: normalizeUrl(url).trim(),
                  pairingToken: token,
                  lastUsed,
                };
              })
              .filter((item): item is ConnectionHistoryItem => Boolean(item));
            const uniqueByUrl = new Map<string, ConnectionHistoryItem>();
            safeHistory.forEach((item) => {
              const existing = uniqueByUrl.get(item.id);
              if (!existing) {
                uniqueByUrl.set(item.id, item);
                return;
              }
              const existingTime = Date.parse(existing.lastUsed) || 0;
              const nextTime = Date.parse(item.lastUsed) || 0;
              if (nextTime > existingTime) {
                uniqueByUrl.set(item.id, item);
              }
            });
            const deduped = Array.from(uniqueByUrl.values())
              .sort((a, b) => {
                const timeA = Date.parse(a.lastUsed) || 0;
                const timeB = Date.parse(b.lastUsed) || 0;
                return timeB - timeA;
              })
              .slice(0, HISTORY_LIMIT);
            if (active) {
              setConnectionHistory(deduped);
            }
          }
        } catch {
          // Ignore invalid cached history.
        }
      }
      const storedOutputs = stored[STORAGE_KEYS.terminalOutputs];
      if (storedOutputs) {
        try {
          const parsed = JSON.parse(storedOutputs);
          if (parsed && typeof parsed === "object") {
            const safeEntries = Object.entries(parsed).filter(
              ([key, value]) => typeof key === "string" && typeof value === "string",
            );
            if (active) {
              setTerminalOutputs(Object.fromEntries(safeEntries));
            }
          }
        } catch {
          // Ignore invalid cached output.
        }
      }
    };
    loadSettings().catch(() => {
      // Ignore storage load errors.
      if (active) {
        settingsLoadedRef.current = true;
        setSettingsReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadDeviceId = async () => {
      const stored = await AsyncStorage.getItem("tunnel_device_id");
      if (!active) return;
      if (stored) {
        setClientId(stored);
        return;
      }
      const generated = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await AsyncStorage.setItem("tunnel_device_id", generated);
      if (active) {
        setClientId(generated);
      }
    };
    loadDeviceId().catch(() => {
      if (active && !clientIdRef.current) {
        const fallback = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setClientId(fallback);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const errorUtils = (globalThis as {
      ErrorUtils?: {
        getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
        setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
      };
    }).ErrorUtils;
    const previousHandler = errorUtils?.getGlobalHandler?.();
    if (errorUtils?.setGlobalHandler) {
      errorUtils.setGlobalHandler((error, isFatal) => {
        let message = "unknown";
        if (error instanceof Error) {
          message = error.message;
        } else if (typeof error === "string") {
          message = error;
        } else {
          try {
            message = JSON.stringify(error);
          } catch {
            message = String(error);
          }
        }
        pushLog(`JS ${isFatal ? "fatal" : "error"}: ${message}`);
        previousHandler?.(error, isFatal);
      });
    }
    return () => {
      if (previousHandler && errorUtils?.setGlobalHandler) {
        errorUtils.setGlobalHandler(previousHandler);
      }
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    pushLog(`AppState: ${AppState.currentState}`);
    const subscription = AppState.addEventListener("change", (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;
      pushLog(`AppState: ${prev} -> ${nextState}`);
      if (nextState === "active" && connectionRef.current === "connected") {
        requestSessions();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    if (!sessions.some((session) => session.id === activeSessionId)) {
      setActiveSessionId(null);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (activeSessionId || sessions.length === 0) return;
    const first = sessions[0];
    if (!first) return;
    setActiveSessionId(first.id);
    if (connectionRef.current === "connected") {
      requestSnapshot(first.id);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (connection !== "connected") return;
    const poll = setInterval(() => {
      requestSessions();
    }, SESSION_POLL_MS);
    return () => clearInterval(poll);
  }, [connection]);

  useEffect(() => {
    if (connection !== "connected") return;
    AsyncStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions)).catch(() => {
      // Ignore storage errors.
    });
  }, [connection, sessions]);

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    AsyncStorage.setItem(STORAGE_KEYS.terminalOutputs, JSON.stringify(terminalOutputs)).catch(() => {
      // Ignore storage errors.
    });
  }, [terminalOutputs]);

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    if (!activeSessionId) {
      AsyncStorage.removeItem(STORAGE_KEYS.activeSession).catch(() => {
        // Ignore storage errors.
      });
      return;
    }
    AsyncStorage.setItem(STORAGE_KEYS.activeSession, activeSessionId).catch(() => {
      // Ignore storage errors.
    });
  }, [activeSessionId]);

  const normalizeUrl = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      try {
        const url = new URL(trimmed);
        const protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return `${protocol}//${url.host}/ws`;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  };

  const buildWsUrl = (raw: string, token: string) => {
    const normalized = normalizeUrl(raw);
    if (!token.trim()) return normalized;
    try {
      const url = new URL(normalized);
      url.searchParams.set("token", token.trim());
      return url.toString();
    } catch {
      return normalized;
    }
  };

  const parseQrPayload = (payload: string) => {
    const trimmed = payload.trim();
    if (!trimmed) return null;

    const fromUrl = (value: string) => {
      try {
        const normalizedValue = value
          .replace(/^intellij-tunnel:\/\//i, "https://")
          .replace(/^tunnel:\/\//i, "https://");
        const url = new URL(normalizedValue);
        const token =
          url.searchParams.get("token") ??
          url.searchParams.get("pairingToken") ??
          url.searchParams.get("pairing_token");
        const serverUrl = `${url.protocol}//${url.host}${url.pathname}`;
        return { serverUrl, pairingToken: token ?? undefined };
      } catch {
        return null;
      }
    };

    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          const rawUrl =
            typeof parsed.serverUrl === "string"
              ? parsed.serverUrl
              : typeof parsed.url === "string"
                ? parsed.url
                : typeof parsed.server === "string"
                  ? parsed.server
                  : typeof parsed.host === "string"
                    ? parsed.host
                    : undefined;
          const rawToken =
            typeof parsed.pairingToken === "string"
              ? parsed.pairingToken
              : typeof parsed.token === "string"
                ? parsed.token
                : typeof parsed["pairing_token"] === "string"
                  ? parsed["pairing_token"]
                  : undefined;
          const parsedUrl = rawUrl ? fromUrl(rawUrl) : null;
          const serverUrl = parsedUrl?.serverUrl ?? rawUrl;
          const pairingToken = rawToken ?? parsedUrl?.pairingToken;
          if (serverUrl || pairingToken) {
            return { serverUrl, pairingToken };
          }
        }
      } catch {
        // Ignore malformed JSON payloads.
      }
    }

    const parsedUrl = fromUrl(trimmed);
    if (parsedUrl && (parsedUrl.serverUrl || parsedUrl.pairingToken)) {
      return parsedUrl;
    }

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && /[./:]/.test(trimmed)) {
      const hostUrl = fromUrl(`http://${trimmed}`);
      if (hostUrl && (hostUrl.serverUrl || hostUrl.pairingToken)) {
        return hostUrl;
      }
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && /[./:]/.test(parts[0])) {
      return { serverUrl: parts[0], pairingToken: parts[1] };
    }

    return null;
  };

  const applyQrPayload = (payload: string) => {
    const parsed = parseQrPayload(payload);
    if (!parsed) {
      setScanError("Unrecognized QR code. Expected a URL or JSON payload.");
      return false;
    }
    let applied = false;
    if (parsed.serverUrl) {
      setServerUrl(normalizeUrl(parsed.serverUrl));
      applied = true;
    }
    if (parsed.pairingToken) {
      setPairingToken(parsed.pairingToken.trim());
      applied = true;
    }
    if (!applied) {
      setScanError("QR code did not include a URL or token.");
      return false;
    }
    setScanError(null);
    return true;
  };

  const resetScannerError = () => {
    if (scanResetTimerRef.current) {
      clearTimeout(scanResetTimerRef.current);
      scanResetTimerRef.current = null;
    }
    scanLockRef.current = false;
    setScanError(null);
  };

  const openScanner = () => {
    setScannerVisible(true);
    if (!cameraPermission?.granted) {
      requestCameraPermission().catch(() => {
        // Ignore permission errors.
      });
    }
  };

  const handleQrScanned = ({ data }: { data: string }) => {
    if (scanLockRef.current) return;
    scanLockRef.current = true;
    const applied = applyQrPayload(data);
    if (applied) {
      setScannerVisible(false);
      return;
    }
    if (scanResetTimerRef.current) {
      clearTimeout(scanResetTimerRef.current);
    }
    scanResetTimerRef.current = setTimeout(() => {
      scanLockRef.current = false;
    }, 1200);
  };

  const isInvalidTokenText = (value?: string | null) => {
    if (!value) return false;
    const lower = value.toLowerCase();
    return lower.includes("invalid_token") || (lower.includes("invalid") && lower.includes("token"));
  };

  const isInvalidTokenCode = (value?: string) => {
    if (!value) return false;
    return value.toLowerCase() === "invalid_token";
  };

  const mergeStyleRuns = (runs: TerminalStyleRun[]) => {
    if (runs.length <= 1) return runs;
    const sorted = [...runs].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: TerminalStyleRun[] = [];
    sorted.forEach((run) => {
      const last = merged[merged.length - 1];
      if (
        last &&
        last.end === run.start &&
        last.fg === run.fg &&
        last.bg === run.bg &&
        Boolean(last.bold) === Boolean(run.bold) &&
        Boolean(last.italic) === Boolean(run.italic) &&
        Boolean(last.underline) === Boolean(run.underline)
      ) {
        last.end = run.end;
      } else {
        merged.push({ ...run });
      }
    });
    return merged;
  };

  const remapStyleRuns = (
    runs: TerminalStyleRun[] | null | undefined,
    keptRanges: { start: number; end: number; newStart: number }[],
    originalLength: number,
  ) => {
    if (!runs || runs.length === 0) return runs ?? null;
    if (keptRanges.length === 0) return [];
    const remapped: TerminalStyleRun[] = [];
    runs.forEach((run) => {
      if (typeof run.start !== "number" || typeof run.end !== "number") return;
      const clampedStart = Math.max(0, Math.min(run.start, originalLength));
      const clampedEnd = Math.max(clampedStart, Math.min(run.end, originalLength));
      if (clampedEnd <= clampedStart) return;
      keptRanges.forEach((range) => {
        const start = Math.max(clampedStart, range.start);
        const end = Math.min(clampedEnd, range.end);
        if (start >= end) return;
        const newStart = range.newStart + (start - range.start);
        const newEnd = newStart + (end - start);
        remapped.push({
          ...run,
          start: newStart,
          end: newEnd,
        });
      });
    });
    return mergeStyleRuns(remapped);
  };

  const filterTerminalOutputWithCursor = (
    value: string,
    cursorOffset: number | null,
    styles?: TerminalStyleRun[] | null,
  ) => {
    const removeNeedle =
      "Unable to proceed. Could not locate working directory.: No such file or directory (os error 2)";
    const lines = value.split(/\r?\n/);
    let offset = cursorOffset;
    let cursorDropped = false;
    let index = 0;
    let nextOutput = "";
    const keptRanges: { start: number; end: number; newStart: number }[] = [];
    lines.forEach((line, lineIndex) => {
      const hasNewline = lineIndex < lines.length - 1;
      const lineLength = line.length + (hasNewline ? 1 : 0);
      if (line.includes(removeNeedle)) {
        if (typeof offset === "number" && !cursorDropped) {
          if (offset >= index + lineLength) {
            offset -= lineLength;
          } else if (offset >= index) {
            cursorDropped = true;
            offset = null;
          }
        }
      } else {
        const start = index;
        const end = index + lineLength;
        const newStart = nextOutput.length;
        keptRanges.push({ start, end, newStart });
        nextOutput += value.slice(start, end);
      }
      index += lineLength;
    });
    const nextStyles =
      styles && keptRanges.length !== lines.length
        ? remapStyleRuns(styles, keptRanges, value.length)
        : styles ?? null;
    return {
      output: nextOutput,
      cursorOffset: cursorDropped ? null : offset,
      styles: nextStyles,
    };
  };

  const buildStyledSegments = (value: string, styles?: TerminalStyleRun[] | null) => {
    if (!styles || styles.length === 0) {
      return [{ text: value, style: null as TextStyle | null }];
    }
    const sorted = [...styles].sort((a, b) => a.start - b.start || a.end - b.end);
    const segments: { text: string; style: TextStyle | null }[] = [];
    const styleCache = new Map<string, TextStyle>();
    let index = 0;
    const makeStyle = (run: TerminalStyleRun) => {
      const key = `${run.fg ?? ""}|${run.bg ?? ""}|${run.bold ? 1 : 0}|${run.italic ? 1 : 0}|${
        run.underline ? 1 : 0
      }`;
      const cached = styleCache.get(key);
      if (cached) return cached;
      const style: TextStyle = {};
      if (run.fg) {
        style.color = run.fg;
      }
      if (run.bg) {
        style.backgroundColor = run.bg;
      }
      if (run.bold) {
        style.fontWeight = "700";
      }
      if (run.italic) {
        style.fontStyle = "italic";
      }
      if (run.underline) {
        style.textDecorationLine = "underline";
      }
      styleCache.set(key, style);
      return style;
    };
    sorted.forEach((run) => {
      const start = Math.max(0, Math.min(run.start, value.length));
      const end = Math.max(start, Math.min(run.end, value.length));
      if (start > index) {
        segments.push({ text: value.slice(index, start), style: null });
      }
      if (end > start) {
        segments.push({ text: value.slice(start, end), style: makeStyle(run) });
      }
      index = end;
    });
    if (index < value.length) {
      segments.push({ text: value.slice(index), style: null });
    }
    return segments;
  };

  const buildOutputNodes = (
    segments: { text: string; style: TextStyle | null }[],
    cursorOffset: number | null,
    showCursor: boolean,
  ) => {
    if (!showCursor || typeof cursorOffset !== "number" || Number.isNaN(cursorOffset)) {
      return segments.map((segment, idx) => {
        if (!segment.text) return null;
        if (!segment.style) return segment.text;
        return (
          <Text key={`seg-${idx}`} style={segment.style}>
            {segment.text}
          </Text>
        );
      });
    }
    const totalLength = segments.reduce((acc, segment) => acc + segment.text.length, 0);
    const clampedOffset = Math.max(0, Math.min(cursorOffset, totalLength));
    const nodes: React.ReactNode[] = [];
    let cursorInserted = false;
    let index = 0;
    let keyIndex = 0;
    segments.forEach((segment) => {
      if (!segment.text) return;
      const segmentEnd = index + segment.text.length;
      if (!cursorInserted && clampedOffset >= index && clampedOffset < segmentEnd) {
        const splitIndex = Math.max(0, Math.min(clampedOffset - index, segment.text.length - 1));
        const before = segment.text.slice(0, splitIndex);
        const cursorChar = segment.text.charAt(splitIndex);
        const after = segment.text.slice(splitIndex + 1);
        if (before) {
          if (segment.style) {
            nodes.push(
              <Text key={`seg-${keyIndex++}`} style={segment.style}>
                {before}
              </Text>
            );
          } else {
            nodes.push(before);
          }
        }
        nodes.push(
          <Text
            key={`cursor-${keyIndex++}`}
            style={segment.style ? [segment.style, styles.outputCursor] : styles.outputCursor}
          >
            {cursorChar || " "}
          </Text>
        );
        cursorInserted = true;
        if (after) {
          if (segment.style) {
            nodes.push(
              <Text key={`seg-${keyIndex++}`} style={segment.style}>
                {after}
              </Text>
            );
          } else {
            nodes.push(after);
          }
        }
      } else {
        if (segment.style) {
          nodes.push(
            <Text key={`seg-${keyIndex++}`} style={segment.style}>
              {segment.text}
            </Text>
          );
        } else {
          nodes.push(segment.text);
        }
      }
      index = segmentEnd;
    });
    if (!cursorInserted && clampedOffset === index) {
      nodes.push(
        <Text key={`cursor-${keyIndex++}`} style={styles.outputCursor}>
          {" "}
        </Text>
      );
    }
    return nodes;
  };

  const scrollOutputToEnd = (animated: boolean) => {
    const scrollView = outputScrollRef.current;
    if (!scrollView) return;
    const contentHeight = outputContentHeightRef.current;
    const layoutHeight = outputLayoutHeightRef.current;
    if (!contentHeight || !layoutHeight) {
      scrollView.scrollToEnd({ animated });
      return;
    }
    const y = Math.max(0, contentHeight - layoutHeight);
    scrollView.scrollTo({ y, animated });
  };

  const handleOutputContentSizeChange = (_width: number, height: number) => {
    outputContentHeightRef.current = height;
    if (!autoScrollEnabledRef.current) return;
    scrollOutputToEnd(true);
  };

  const handleOutputLayout = (event: LayoutChangeEvent) => {
    outputLayoutHeightRef.current = event.nativeEvent.layout.height;
    if (!autoScrollEnabledRef.current) return;
    scrollOutputToEnd(false);
  };

  const handleOutputScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const paddingToBottom = 24;
    const atBottom =
      contentOffset.y + layoutMeasurement.height >= contentSize.height - paddingToBottom;
    autoScrollEnabledRef.current = atBottom;
  };

  const updateConnectionHistory = (rawUrl: string, rawToken: string) => {
    const normalizedUrl = normalizeUrl(rawUrl).trim();
    const token = rawToken.trim();
    if (!normalizedUrl || !token) return;
    const id = buildHistoryId(normalizedUrl);
    const now = new Date().toISOString();
    setConnectionHistory((prev) => {
      const next = [
        { id, serverUrl: normalizedUrl, pairingToken: token, lastUsed: now },
        ...prev.filter((item) => buildHistoryId(item.serverUrl) !== id),
      ].slice(0, HISTORY_LIMIT);
      AsyncStorage.setItem(STORAGE_KEYS.connectionHistory, JSON.stringify(next)).catch(() => {
        // Ignore storage errors.
      });
      return next;
    });
  };

  const removeConnectionHistory = (rawUrl: string) => {
    const normalizedUrl = normalizeUrl(rawUrl).trim();
    if (!normalizedUrl) return;
    const id = buildHistoryId(normalizedUrl);
    setConnectionHistory((prev) => {
      const next = prev.filter((item) => buildHistoryId(item.serverUrl) !== id);
      AsyncStorage.setItem(STORAGE_KEYS.connectionHistory, JSON.stringify(next)).catch(() => {
        // Ignore storage errors.
      });
      return next;
    });
  };

  const handleInvalidToken = (reason?: string, code?: string) => {
    if (invalidTokenHandledRef.current) return;
    invalidTokenHandledRef.current = true;
    setReconnectPending(false);
    blockReconnect(reason ?? code ?? "invalid token");
    shouldResumeReconnectRef.current = false;
    removeConnectionHistory(serverUrlRef.current);
    setPairingToken("");
    AsyncStorage.removeItem(STORAGE_KEYS.pairingToken).catch(() => {
      // Ignore storage errors.
    });
    setConnectionModalVisible(true);
    pushLog("Invalid pairing token. Please enter a new one.");
  };

  const clearReconnectTimer = () => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  };

  const blockReconnect = (reason: string) => {
    reconnectBlockedRef.current = reason;
    blockedTokenRef.current = pairingTokenRef.current.trim();
    shouldResumeReconnectRef.current = shouldReconnectRef.current;
    shouldReconnectRef.current = false;
    blockNotifiedRef.current = false;
    clearReconnectTimer();
    if (!blockNotifiedRef.current) {
      pushLog("Reconnect blocked: invalid token");
      blockNotifiedRef.current = true;
    }
  };

  const scheduleReconnect = () => {
    if (!shouldReconnectRef.current) return;
    if (reconnectBlockedRef.current) {
      if (!blockNotifiedRef.current) {
        pushLog("Reconnect paused: invalid token");
        blockNotifiedRef.current = true;
      }
      return;
    }
    clearReconnectTimer();
    const attempt = reconnectAttemptsRef.current + 1;
    reconnectAttemptsRef.current = attempt;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
    pushLog(`Reconnect attempt ${attempt} in ${Math.round(delay / 1000)}s`);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, delay);
  };

  const flushPending = () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (pendingSendsRef.current.length === 0) return;
    const pending = pendingSendsRef.current;
    pendingSendsRef.current = [];
    pushLog(`flushed ${pending.length} queued`);
    pending.forEach((payload) => {
      socket.send(JSON.stringify(payload));
      logOutbound(payload, false);
    });
  };

  const queueSend = (payload: Record<string, unknown>) => {
    const pending = pendingSendsRef.current;
    if (pending.length >= 25) {
      pending.shift();
      pushLog("queue full, dropped oldest");
    }
    pending.push(payload);
    logOutbound(payload, true);
  };

  const connect = () => {
    if (connectionRef.current !== "disconnected") return;
    if (reconnectBlockedRef.current) {
      const currentToken = pairingTokenRef.current.trim();
      if (!currentToken || currentToken === blockedTokenRef.current) {
        if (!blockNotifiedRef.current) {
          pushLog("Reconnect blocked: invalid token");
          blockNotifiedRef.current = true;
        }
        return;
      }
    }
    invalidTokenHandledRef.current = false;
    setSessionsLoaded(false);
    shouldReconnectRef.current = true;
    setReconnectPending(true);
    clearReconnectTimer();
    const rawUrl = serverUrlRef.current;
    const resolvedUrl = buildWsUrl(rawUrl, pairingTokenRef.current);
    const normalized = normalizeUrl(rawUrl);
    if (normalized !== rawUrl) {
      setServerUrl(normalized);
    }

    pushLog(`Connecting to ${resolvedUrl}`);
    updateConnection("connecting");
    const socket = new WebSocket(resolvedUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      updateConnection("connected");
      updateConnectionHistory(serverUrlRef.current, pairingTokenRef.current);
      reconnectAttemptsRef.current = 0;
      reconnectBlockedRef.current = null;
      blockedTokenRef.current = null;
      blockNotifiedRef.current = false;
      shouldResumeReconnectRef.current = false;
      subscribedSessionRef.current = null;
      const deviceName = `${Platform.OS}-mobile`;
      const helloPayload = { type: "hello", deviceName, deviceId: clientIdRef.current };
      const listPayload = { type: "list_sessions" };
      const runConfigsPayload = { type: "list_run_configurations" };
      const progressPayload = { type: "list_ide_progress" };
      socket.send(JSON.stringify(helloPayload));
      logOutbound(helloPayload, false);
      socket.send(JSON.stringify(listPayload));
      logOutbound(listPayload, false);
      socket.send(JSON.stringify(runConfigsPayload));
      logOutbound(runConfigsPayload, false);
      socket.send(JSON.stringify(progressPayload));
      logOutbound(progressPayload, false);
      flushPending();
      pushLog("Socket connected");
    };

    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        logInbound(message);
        if (message.type === "hello_ack") {
          setDeviceId(message.deviceId);
        } else if (message.type === "approval_required") {
          pushLog(message.message ?? "Approval required by IDE");
        } else if (message.type === "approval_pending") {
          pushLog(message.message ?? "Waiting for approval");
        } else if (message.type === "approval_granted") {
          pushLog("Device approved");
          requestSessions();
        } else if (message.type === "approval_denied") {
          pushLog(message.message ?? "Device denied");
          disconnect();
        } else if (message.type === "sessions") {
          setSessions(message.items);
          setSessionsLoaded(true);
        } else if (message.type === "terminal_started") {
          setSessions((prev) => [...prev, message.session]);
          setActiveSessionId(message.session.id);
          send({ type: "terminal_snapshot", sessionId: message.session.id, lines: 200 });
          pushLog(`Terminal started: ${message.session.name}`);
          setSessionsLoaded(true);
        } else if (message.type === "terminal_output") {
          setTerminalOutputs((prev) => ({ ...prev, [message.sessionId]: message.output }));
          setTerminalCursorOffsets((prev) => ({
            ...prev,
            [message.sessionId]: typeof message.cursorOffset === "number" ? message.cursorOffset : null,
          }));
          setTerminalOutputStyles((prev) => ({
            ...prev,
            [message.sessionId]: Array.isArray(message.styles) ? message.styles : null,
          }));
        } else if (message.type === "terminal_closed") {
          setSessions((prev) => prev.filter((session) => session.id !== message.sessionId));
          setTerminalOutputs((prev) => {
            const next = { ...prev };
            delete next[message.sessionId];
            return next;
          });
          setTerminalCursorOffsets((prev) => {
            const next = { ...prev };
            delete next[message.sessionId];
            return next;
          });
          setTerminalOutputStyles((prev) => {
            const next = { ...prev };
            delete next[message.sessionId];
            return next;
          });
          setActiveSessionId((current) => (current === message.sessionId ? null : current));
          setSessionsLoaded(true);
        } else if (message.type === "ide_progress") {
          setIdeProgress(message.tasks ?? []);
        } else if (message.type === "build_status") {
          setBuildStatus(message.status);
          if (message.message) {
            pushLog(`Build: ${message.message}`);
          }
        } else if (message.type === "build_output") {
          appendOutputLines(
            "Build",
            message.title,
            message.text,
            message.level,
            message.projectName,
          );
        } else if (message.type === "run_configurations") {
          setRunConfigurations(message.items ?? []);
        } else if (message.type === "run_configuration_status") {
          const label = (message.name ?? message.id) || "Unknown configuration";
          if (message.status === "started") {
            pushLog(`Run started: ${label}`);
          } else {
            pushLog(`Run ${message.status}: ${label}${message.message ? ` (${message.message})` : ""}`);
          }
        } else if (message.type === "run_output") {
          appendOutputLines(
            "Run",
            message.name,
            message.text,
            message.stream,
            message.projectName,
          );
        } else if (message.type === "terminal_error") {
          pushLog(`Terminal: ${message.message}`);
        } else if (message.type === "error") {
          const errorMessage = message.message ?? "unknown";
          pushLog(`Server error: ${errorMessage}`);
          if (isInvalidTokenCode(message.code) || isInvalidTokenText(errorMessage)) {
            handleInvalidToken(errorMessage, message.code);
          }
        }
      } catch {
        pushLog("Received unparseable message");
      }
    };

    socket.onclose = (event) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      updateConnection("disconnected");
      setDeviceId(null);
      subscribedSessionRef.current = null;
      setSessionsLoaded(false);
      setRunConfigurations([]);
      setIdeProgress([]);
      const reason = event.reason ? `: ${event.reason}` : "";
      pushLog(`Socket disconnected (${event.code}${reason})`);
      if (isInvalidTokenText(event.reason)) {
        handleInvalidToken(event.reason);
        return;
      }
      scheduleReconnect();
    };

    socket.onerror = (event) => {
      if (socketRef.current !== socket) return;
      const message = "message" in event ? String((event as { message?: string }).message ?? "") : "";
      pushLog(message ? `Socket error: ${message}` : "Socket error");
    };
  };

  const disconnect = () => {
    pushLog("Disconnect requested");
    shouldReconnectRef.current = false;
    autoConnectAttemptedRef.current = true;
    setReconnectPending(false);
    reconnectAttemptsRef.current = 0;
    clearReconnectTimer();
    pendingSendsRef.current = [];
    socketRef.current?.close();
    socketRef.current = null;
    updateConnection("disconnected");
    subscribedSessionRef.current = null;
    setSessionsLoaded(false);
    setRunConfigurations([]);
    setIdeProgress([]);
    setBuildStatus("idle");
  };

  const connectWithHistory = (item: ConnectionHistoryItem) => {
    const nextUrl = item.serverUrl;
    const nextToken = item.pairingToken;
    serverUrlRef.current = nextUrl;
    pairingTokenRef.current = nextToken;
    setServerUrl(nextUrl);
    setPairingToken(nextToken);
    if (connectionRef.current !== "disconnected") {
      disconnect();
    }
    connect();
  };

  const send = (payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      queueSend(payload);
      scheduleReconnect();
      return;
    }
    socket.send(JSON.stringify(payload));
    logOutbound(payload, false);
  };

  useEffect(() => {
    if (connection !== "connected") {
      subscribedSessionRef.current = null;
      return;
    }
    if (!activeSessionId) {
      const previous = subscribedSessionRef.current;
      if (previous) {
        send({ type: "terminal_unsubscribe", sessionId: previous });
        subscribedSessionRef.current = null;
      }
      return;
    }
    const previous = subscribedSessionRef.current;
    if (previous === activeSessionId) return;
    if (previous) {
      send({ type: "terminal_unsubscribe", sessionId: previous });
    }
    send({ type: "terminal_subscribe", sessionId: activeSessionId });
    subscribedSessionRef.current = activeSessionId;
  }, [activeSessionId, connection]);

  const requestSessions = () => {
    if (connectionRef.current !== "connected") return;
    send({ type: "list_sessions" });
  };
  const startSession = () => {
    if (connectionRef.current !== "connected") return;
    send({ type: "start_terminal" });
  };
  const closeSession = (sessionId: string) => {
    if (connectionRef.current !== "connected") return;
    send({ type: "close_terminal", sessionId });
  };
  const requestSnapshot = (sessionId: string) => {
    if (connectionRef.current !== "connected") return;
    send({ type: "terminal_snapshot", sessionId, lines: 200 });
  };
  const sendCommand = (appendNewline: boolean) => {
    if (connectionRef.current !== "connected") return;
    if (transcription.isRecording) return;
    if (!activeSessionId) return;
    const data = command;
    if (!data.trim()) return;
    const payload = appendNewline ? `${data}\r` : data;
    send({ type: "terminal_input", sessionId: activeSessionId, data: payload });
    setCommand("");
    requestSnapshot(activeSessionId);
  };
  const sendRawInput = (data: string) => {
    if (connectionRef.current !== "connected") return;
    if (!activeSessionId) return;
    if (!data) return;
    send({ type: "terminal_input", sessionId: activeSessionId, data });
    requestSnapshot(activeSessionId);
  };
  const submitCommand = () => sendCommand(true);
  const triggerBuild = () => {
    if (connectionRef.current !== "connected") return;
    send({ type: "build_project" });
  };
  const requestRunConfigurations = () => {
    if (connectionRef.current !== "connected") return;
    send({ type: "list_run_configurations" });
  };
  const requestIdeProgress = () => {
    if (connectionRef.current !== "connected") return;
    send({ type: "list_ide_progress" });
  };
  const runConfiguration = (id: string) => {
    if (connectionRef.current !== "connected") return;
    if (!id.trim()) return;
    send({ type: "run_configuration", id });
  };

  const displaySessions = canInteract || showCachedContent ? sessions : [];
  const displayActiveSessionId = canInteract || showCachedContent ? activeSessionId : null;
  const activeOutput = displayActiveSessionId ? terminalOutputs[displayActiveSessionId] ?? "" : "";
  const activeCursorOffset =
    displayActiveSessionId != null ? terminalCursorOffsets[displayActiveSessionId] ?? null : null;
  const activeStyles =
    displayActiveSessionId != null ? terminalOutputStyles[displayActiveSessionId] ?? null : null;
  const { output: filteredOutput, cursorOffset: filteredCursorOffset, styles: filteredStyles } = useMemo(() => {
    return filterTerminalOutputWithCursor(activeOutput, activeCursorOffset, activeStyles);
  }, [activeCursorOffset, activeOutput, activeStyles]);
  const showCursor = canInteract && displayActiveSessionId != null;
  const hasLiveOutput = filteredOutput.length > 0 || (showCursor && filteredCursorOffset != null);
  const outputValue = filteredOutput || (showCursor && filteredCursorOffset != null ? "" : "No output yet.");
  const outputStyles = hasLiveOutput ? filteredStyles : null;
  const outputSegments = useMemo(() => {
    return buildStyledSegments(outputValue, outputStyles);
  }, [outputStyles, outputValue]);
  const outputNodes = useMemo(() => {
    return buildOutputNodes(outputSegments, filteredCursorOffset, showCursor);
  }, [filteredCursorOffset, outputSegments, showCursor]);
  const activeSession = displayActiveSessionId
    ? displaySessions.find((session) => session.id === displayActiveSessionId) ?? null
    : null;
  const shouldSuggestQuickKeys = useMemo(() => {
    if (!showCursor) return false;
    const tail = filteredOutput.slice(-400);
    if (!tail) return false;
    const promptRegex =
      /(press|select|choose|allow|permit|approve|grant|continue|proceed|enter|confirm|authorize|y\/n|\[y\/n\]|\([yY]\/[nN]\)|\b[1-9]\)|\[[1-9]\])/i;
    return promptRegex.test(tail);
  }, [filteredOutput, showCursor]);
  const showQuickKeys = canInteract && activeSession != null && (quickKeysPinned || shouldSuggestQuickKeys);
  const quickKeyButtons = useMemo(
    () => [
      { label: "1", value: "1" },
      { label: "2", value: "2" },
      { label: "3", value: "3" },
      { label: "4", value: "4" },
      { label: "5", value: "5" },
      { label: "6", value: "6" },
      { label: "7", value: "7" },
      { label: "8", value: "8" },
      { label: "9", value: "9" },
      { label: "0", value: "0" },
      { label: "Tab", value: "\t" },
      { label: "Shift+Tab", value: "\u001b[Z" },
      { label: "Esc", value: "\u001b" },
      { label: "Enter", value: "\r" },
    ],
    [],
  );
  const emptyTerminalMessage = (() => {
    if (isLoading) return "Loading sessions...";
    if (!canInteract && !showCachedContent) {
      return "No connection. Tap the status dot to connect.";
    }
    if (canInteract && sessionsLoaded && displaySessions.length === 0) {
      return "No terminals yet. Start one from the IDE.";
    }
    return "Select a session to view output.";
  })();
  const visibleProgressTasks = canInteract ? ideProgress : [];
  const indexingTasks = visibleProgressTasks.filter((task) => task.kind === "indexing");
  const syncTasks = visibleProgressTasks.filter((task) => task.kind === "sync");
  const buildTasks = visibleProgressTasks.filter((task) => task.kind === "build");
  const buildStatusCount = buildTasks.length + syncTasks.length;
  const buildStatusLabel = buildStatusCount > 0 ? `running (${buildStatusCount})` : buildStatus;
  const hasBuildBadge = buildStatus === "started" || buildStatusCount > 0;
  const buildBadgeText = buildStatusCount > 9 ? "9+" : String(buildStatusCount);
  const sortedRunConfigurations = useMemo(() => {
    return [...runConfigurations].sort((a, b) => a.name.localeCompare(b.name));
  }, [runConfigurations]);
  const indexingEmptyMessage = canInteract
    ? "No indexing running."
    : "Connect to see indexing status.";
  const syncEmptyMessage = canInteract
    ? "No project sync running."
    : "Connect to see sync status.";
  const buildEmptyMessage = canInteract ? "No builds running." : "Connect to see build status.";
  const runConfigEmptyMessage = canInteract
    ? "No run configurations found."
    : "Connect to load run configurations.";

  const micDisabled = transcription.isRecording
    ? false
    : !canInteract || !transcription.canStart;
  const micIconColor = micDisabled
    ? THEME.colors.muted
    : transcription.isRecording
    ? THEME.colors.danger
    : THEME.colors.text;
  const micStatus = (() => {
    if (!transcription.isSupported) {
      return "Voice input is only available on device builds.";
    }
    if (transcription.permissionState === "denied") {
      return "Microphone permission denied. Enable it in settings.";
    }
    if (transcription.error) {
      return transcription.error;
    }
    if (!transcription.isReady) {
      return `Loading speech model... ${formatPercent(transcription.downloadProgress)}`;
    }
    if (transcription.isRecording) {
      return "Listening...";
    }
    return "";
  })();
  const micStatusIsError =
    Boolean(transcription.error) || transcription.permissionState === "denied";
  const inputLocked = transcription.isRecording;

  useEffect(() => {
    autoScrollEnabledRef.current = true;
    if (displayActiveSessionId) {
      requestAnimationFrame(() => scrollOutputToEnd(false));
    }
  }, [displayActiveSessionId]);

  const clampFraction = (value?: number | null) => {
    if (value == null || Number.isNaN(value)) return null;
    return Math.min(1, Math.max(0, value));
  };

  const renderProgressTask = (task: IdeProgressTask) => {
    const fraction = clampFraction(task.fraction);
    const percent = fraction === null ? null : Math.round(fraction * 100);
    const accent =
      task.kind === "indexing"
        ? THEME.colors.warning
        : task.kind === "sync"
        ? THEME.colors.success
        : THEME.colors.primary;
    const width = task.indeterminate ? "35%" : percent !== null ? `${percent}%` : "0%";
    const subtitleParts = [task.text, task.projectName ? `Project: ${task.projectName}` : null].filter(
      Boolean,
    ) as string[];
    return (
      <View key={task.id} style={styles.taskRow}>
        <View style={styles.taskHeaderRow}>
          <Text style={styles.taskTitle} numberOfLines={1}>
            {task.title}
          </Text>
          <Text style={styles.taskMeta}>
            {task.indeterminate ? "In progress" : percent !== null ? `${percent}%` : "Queued"}
          </Text>
        </View>
        {subtitleParts.length > 0 ? (
          <Text style={styles.taskSub} numberOfLines={2}>
            {subtitleParts.join(" / ")}
          </Text>
        ) : null}
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width, backgroundColor: accent }]} />
        </View>
      </View>
    );
  };

  const renderRunConfigRow = (config: RunConfigurationItem) => {
    const meta = [config.type, config.folder].filter(Boolean).join(" / ");
    return (
      <View key={config.id} style={styles.runConfigRow}>
        <View style={styles.runConfigInfo}>
          <Text style={styles.runConfigName} numberOfLines={1}>
            {config.name}
          </Text>
          {meta ? (
            <Text style={styles.runConfigMeta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        <Pressable
          style={[styles.runButton, !canInteract && styles.runButtonDisabled]}
          onPress={() => runConfiguration(config.id)}
          disabled={!canInteract}
        >
          <Text style={styles.runButtonText}>Run</Text>
        </Pressable>
      </View>
    );
  };

  if (!fontsLoaded) {
    return null;
  }

  return (
    <LinearGradient
      colors={[
        THEME.colors.backgroundTop,
        THEME.colors.backgroundMid,
        THEME.colors.backgroundBottom,
      ]}
      style={styles.container}
    >
      <StatusBar style="light" />
      <Modal
        visible={connectionModalOpen}
        animationType={Platform.OS === "ios" ? "slide" : "fade"}
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
        onRequestClose={() => {
          if (!shouldForceConnectionModal) {
            setConnectionModalVisible(false);
          }
        }}
      >
        <LinearGradient
          colors={[
            THEME.colors.backgroundTop,
            THEME.colors.backgroundMid,
            THEME.colors.backgroundBottom,
          ]}
          style={styles.modalContainer}
        >
          <SafeAreaView style={styles.modalSafeArea}>
            <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
              <View style={styles.card}>
                <View style={styles.modalHeader}>
                  <Text style={styles.cardTitle}>New connection</Text>
                  {!shouldForceConnectionModal ? (
                    <Pressable
                      style={styles.modalCloseButton}
                      onPress={() => setConnectionModalVisible(false)}
                    >
                      <Text style={styles.modalCloseText}>Done</Text>
                    </Pressable>
                  ) : null}
                </View>
                <Text style={[styles.modalHint, styles.modalSubHint]}>
                  Make sure you launched the InTunnel plugin in IntelliJ and opened it.
                </Text>
                <Pressable
                  style={[styles.button, styles.buttonPrimary, styles.qrPrimaryButton]}
                  onPress={openScanner}
                  accessibilityLabel="Scan QR code"
                >
                  <View style={styles.qrIcon}>
                    <View style={[styles.qrIconFinder, styles.qrIconFinderTopLeft]} />
                    <View style={[styles.qrIconFinder, styles.qrIconFinderTopRight]} />
                    <View style={[styles.qrIconFinder, styles.qrIconFinderBottomLeft]} />
                    <View style={styles.qrIconDot} />
                  </View>
                  <Text style={styles.qrPrimaryButtonText}>Scan QR code</Text>
                </Pressable>
                <Text style={[styles.modalHint, styles.manualEntryHint]}>Manual entry (fallback)</Text>
                <View style={styles.urlRow}>
                  <TextInput
                    style={[styles.input, styles.urlInput]}
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="ws://host:8765/ws"
                    placeholderTextColor="rgba(248, 250, 252, 0.4)"
                  />
                </View>
                <TextInput
                  style={styles.input}
                  value={pairingToken}
                  onChangeText={setPairingToken}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="pairing token"
                  placeholderTextColor="rgba(248, 250, 252, 0.4)"
                />
                <View style={styles.buttonRow}>
                  <Pressable
                    style={[styles.button, styles.buttonPrimary, connection !== "disconnected" && styles.buttonDisabled]}
                    onPress={connect}
                    disabled={connection !== "disconnected"}
                  >
                    <Text style={styles.buttonText}>Connect</Text>
                  </Pressable>
                  <Pressable style={[styles.button, styles.buttonGhost]} onPress={disconnect}>
                    <Text style={styles.buttonText}>Disconnect</Text>
                  </Pressable>
                </View>
                <View style={styles.statusRow}>
                  <Animated.View
                    style={[styles.statusDot, { backgroundColor: statusColor }, pulsingStatusStyle]}
                  />
                  <Text style={styles.statusText}>{statusLabel}</Text>
                  {deviceId ? <Text style={styles.statusMeta}>ID {deviceId.slice(0, 6)}</Text> : null}
                </View>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Saved connections</Text>
                {connectionHistory.length > 0 ? (
                  <View style={styles.historyList}>
                    {connectionHistory.map((item) => (
                      <View key={item.id} style={styles.historyItem}>
                        <Pressable
                          style={styles.historyItemMain}
                          onPress={() => {
                            setConnectionModalVisible(false);
                            connectWithHistory(item);
                          }}
                        >
                          <Text style={styles.historyUrl} numberOfLines={1}>
                            {item.serverUrl}
                          </Text>
                          <Text style={styles.historyMeta} numberOfLines={1}>
                            {formatLastUsed(item.lastUsed)}
                          </Text>
                        </Pressable>
                        <Pressable
                          style={styles.historyDelete}
                          onPress={() => removeConnectionHistory(item.serverUrl)}
                        >
                          <Text style={styles.historyDeleteText}>Remove</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.muted}>No saved connections yet.</Text>
                )}
              </View>
            </ScrollView>
          </SafeAreaView>
        </LinearGradient>
      </Modal>
      <Modal
        visible={scannerVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setScannerVisible(false)}
      >
        <LinearGradient
          colors={[
            THEME.colors.backgroundTop,
            THEME.colors.backgroundMid,
            THEME.colors.backgroundBottom,
          ]}
          style={styles.modalContainer}
        >
          <SafeAreaView style={styles.modalSafeArea}>
            <View style={styles.scannerHeader}>
              <Text style={styles.cardTitle}>Scan QR code</Text>
              <Pressable
                style={styles.modalCloseButton}
                onPress={() => setScannerVisible(false)}
              >
                <Text style={styles.modalCloseText}>Close</Text>
              </Pressable>
            </View>
            <View style={styles.scannerBody}>
              {cameraPermission?.granted ? (
                <>
                  <View style={styles.scannerPreview}>
                    <CameraView
                      style={styles.scannerCamera}
                      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                      onBarcodeScanned={handleQrScanned}
                    />
                    <View pointerEvents="none" style={styles.scannerFrameOverlay}>
                      <View style={styles.scannerFrame} />
                    </View>
                  </View>
                  <View style={styles.scannerFooter}>
                    <Text style={styles.scannerHint}>Align the QR code inside the frame.</Text>
                    {scanError ? <Text style={styles.scanError}>{scanError}</Text> : null}
                    {scanError ? (
                      <Pressable
                        style={[styles.button, styles.buttonSecondary]}
                        onPress={resetScannerError}
                      >
                        <Text style={styles.buttonText}>Try again</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              ) : (
                <View style={styles.scannerPermission}>
                  <Text style={styles.cardTitle}>Camera access</Text>
                  <Text style={styles.muted}>We need permission to scan QR codes.</Text>
                  {cameraPermission?.canAskAgain !== false ? (
                    <Pressable
                      style={[styles.button, styles.buttonPrimary]}
                      onPress={() => {
                        requestCameraPermission().catch(() => {
                          // Ignore permission errors.
                        });
                      }}
                    >
                      <Text style={styles.buttonText}>Allow camera</Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.scanError}>Enable camera access in Settings.</Text>
                  )}
                </View>
              )}
            </View>
          </SafeAreaView>
        </LinearGradient>
      </Modal>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.screen}>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.headerRow}>
              <View style={styles.headerText}>
                <Text style={styles.title}>IntelliJ Tunnel</Text>
                <Text style={styles.subtitle}>Pair to your IDE and keep builds in your pocket.</Text>
              </View>
              <Pressable
                onPress={() => setConnectionModalVisible(true)}
                style={styles.statusButton}
              >
                <Animated.View
                  style={[styles.statusIndicator, { backgroundColor: statusColor }, pulsingStatusStyle]}
                />
              </Pressable>
            </View>

            {activeTab === "terminal" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Terminal</Text>
                {!isLoading && (canInteract || showCachedContent) ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.tabsRow}
                  >
                    {displaySessions.map((session) => (
                      <Pressable
                        key={session.id}
                        style={[
                          styles.tab,
                          displayActiveSessionId === session.id && styles.tabActive,
                        ]}
                        onPress={() => {
                          setActiveSessionId(session.id);
                          if (canInteract) {
                            requestSnapshot(session.id);
                          }
                        }}
                      >
                        <Text style={styles.tabTitle} numberOfLines={1}>
                          {session.name}
                        </Text>
                      </Pressable>
                    ))}
                    {canInteract ? (
                      <Pressable style={[styles.tab, styles.tabAdd]} onPress={startSession}>
                        <Text style={styles.tabAddText}>+</Text>
                      </Pressable>
                    ) : null}
                  </ScrollView>
                ) : null}
                {activeSession && !isLoading ? (
                  <>
                    <ScrollView
                      ref={outputScrollRef}
                      style={styles.outputScroll}
                      contentContainerStyle={styles.outputScrollContent}
                      nestedScrollEnabled
                      onScroll={handleOutputScroll}
                      onContentSizeChange={handleOutputContentSizeChange}
                      onLayout={handleOutputLayout}
                      scrollEventThrottle={16}
                    >
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator
                        nestedScrollEnabled
                        contentContainerStyle={styles.outputHorizontalContent}
                      >
                      <Text style={styles.outputText}>
                        {outputNodes}
                      </Text>
                      </ScrollView>
                    </ScrollView>
                    <View style={styles.commandBlock}>
                      <View style={styles.commandRow}>
                        <TextInput
                          style={[styles.input, styles.commandInput]}
                          value={command}
                          onChangeText={setCommand}
                          autoCapitalize="none"
                          autoCorrect={false}
                          blurOnSubmit={false}
                          returnKeyType="send"
                          onSubmitEditing={submitCommand}
                          placeholder="Enter command"
                          placeholderTextColor="rgba(248, 250, 252, 0.4)"
                          editable={canInteract && !inputLocked}
                          selectTextOnFocus={canInteract && !inputLocked}
                        />
                        <Pressable
                          style={[
                            styles.micButton,
                            transcription.isRecording && styles.micButtonActive,
                            micDisabled && styles.commandButtonDisabled,
                          ]}
                          onPress={transcription.isRecording ? transcription.stop : transcription.start}
                          disabled={micDisabled}
                        >
                          <View style={styles.micIcon}>
                            <View style={[styles.micIconHead, { borderColor: micIconColor }]} />
                            <View style={[styles.micIconStem, { backgroundColor: micIconColor }]} />
                            <View style={[styles.micIconBase, { backgroundColor: micIconColor }]} />
                          </View>
                        </Pressable>
                        <Pressable
                          style={[
                            styles.button,
                            styles.buttonPrimary,
                            (!canInteract || !command.trim() || inputLocked) && styles.buttonDisabled,
                          ]}
                          onPress={submitCommand}
                          disabled={!canInteract || !command.trim() || inputLocked}
                        >
                          <Text style={styles.buttonText}>Send</Text>
                        </Pressable>
                      </View>
                      {canInteract ? (
                        <View style={styles.quickKeysToggleRow}>
                          <Pressable
                            style={[styles.quickKeysToggle, quickKeysPinned && styles.quickKeysToggleActive]}
                            onPress={() => setQuickKeysPinned((prev) => !prev)}
                          >
                            <Text style={styles.quickKeysToggleText}>
                              {quickKeysPinned ? "Hide keys" : "Show keys"}
                            </Text>
                          </Pressable>
                          {shouldSuggestQuickKeys && !quickKeysPinned ? (
                            <Text style={styles.quickKeysHint}>Prompt detected</Text>
                          ) : null}
                        </View>
                      ) : null}
                      {showQuickKeys ? (
                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={styles.quickKeysRow}
                        >
                          {quickKeyButtons.map((key) => (
                            <Pressable
                              key={key.label}
                              style={styles.quickKeyButton}
                              onPress={() => sendRawInput(key.value)}
                            >
                              <Text style={styles.quickKeyText}>{key.label}</Text>
                            </Pressable>
                          ))}
                        </ScrollView>
                      ) : null}
                      {micStatus ? (
                        <Text style={[styles.muted, micStatusIsError && styles.micStatusError]}>
                          {micStatus}
                        </Text>
                      ) : null}
                    </View>
                    {canInteract ? (
                      <View style={styles.sessionActionRow}>
                        <Pressable
                          style={[styles.button, styles.buttonDangerOutline, styles.sessionActionButton]}
                          onPress={() => closeSession(activeSession.id)}
                        >
                          <Text style={styles.buttonText}>Close</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.button, styles.buttonSecondary, styles.sessionActionButton]}
                          onPress={() => requestSnapshot(activeSession.id)}
                        >
                          <Text style={styles.buttonText}>Refresh output</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.muted}>{emptyTerminalMessage}</Text>
                )}
              </View>
            ) : null}

            {activeTab === "builds" ? (
              <View style={styles.card}>
                <View style={styles.cardHeaderRow}>
                  <View style={styles.cardHeaderText}>
                    <Text style={styles.cardTitle}>Builds</Text>
                    <Text style={styles.muted}>Status: {buildStatusLabel}</Text>
                  </View>
                  <Pressable
                    style={[styles.button, styles.buttonPrimary, !canInteract && styles.buttonDisabled]}
                    onPress={triggerBuild}
                    disabled={!canInteract}
                  >
                    <Text style={styles.buttonText}>Run build</Text>
                  </Pressable>
                </View>
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Indexing</Text>
                    {indexingTasks.length > 0 ? (
                      <Text style={styles.sectionMeta}>{indexingTasks.length} running</Text>
                    ) : null}
                  </View>
                  {indexingTasks.length > 0 ? (
                    indexingTasks.map(renderProgressTask)
                  ) : (
                    <Text style={styles.muted}>{indexingEmptyMessage}</Text>
                  )}
                </View>
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Project sync</Text>
                    {syncTasks.length > 0 ? (
                      <Text style={styles.sectionMeta}>{syncTasks.length} running</Text>
                    ) : null}
                  </View>
                  {syncTasks.length > 0 ? (
                    syncTasks.map(renderProgressTask)
                  ) : (
                    <Text style={styles.muted}>{syncEmptyMessage}</Text>
                  )}
                </View>
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Builds</Text>
                    {buildTasks.length > 0 ? (
                      <Text style={styles.sectionMeta}>{buildTasks.length} running</Text>
                    ) : null}
                  </View>
                  {buildTasks.length > 0 ? (
                    buildTasks.map(renderProgressTask)
                  ) : (
                    <Text style={styles.muted}>{buildEmptyMessage}</Text>
                  )}
                </View>
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Run configurations</Text>
                    <Pressable
                      style={styles.sectionAction}
                      onPress={() => {
                        requestRunConfigurations();
                        requestIdeProgress();
                      }}
                      disabled={!canInteract}
                    >
                      <Text
                        style={[
                          styles.sectionActionText,
                          !canInteract && styles.sectionActionTextDisabled,
                        ]}
                      >
                        Refresh
                      </Text>
                    </Pressable>
                  </View>
                  {sortedRunConfigurations.length > 0 ? (
                    sortedRunConfigurations.map(renderRunConfigRow)
                  ) : (
                    <Text style={styles.muted}>{runConfigEmptyMessage}</Text>
                  )}
                </View>
              </View>
            ) : null}

            {activeTab === "assistant" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Voice assistant</Text>
                <VoiceAssistant />
              </View>
            ) : null}

            {activeTab === "activity" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Activity</Text>
                {logs.length === 0 ? (
                  <Text style={styles.muted}>No activity yet.</Text>
                ) : (
                  logs.map((entry, index) => (
                    <Text key={`${entry}-${index}`} style={styles.logEntry}>
                      {entry}
                    </Text>
                  ))
                )}
              </View>
            ) : null}
          </ScrollView>
          <View style={styles.bottomBar}>
            <View style={styles.bottomBarInner}>
              <Pressable
                style={[styles.bottomTab, activeTab === "terminal" && styles.bottomTabActive]}
                onPress={() => setActiveTab("terminal")}
              >
                <View
                  style={[
                    styles.bottomTabIndicator,
                    activeTab === "terminal" && styles.bottomTabIndicatorActive,
                  ]}
                />
                <Text
                  style={[
                    styles.bottomTabText,
                    activeTab === "terminal" && styles.bottomTabTextActive,
                  ]}
                >
                  Terminal
                </Text>
              </Pressable>
              <Pressable
                style={[styles.bottomTab, activeTab === "builds" && styles.bottomTabActive]}
                onPress={() => setActiveTab("builds")}
              >
                <View
                  style={[
                    styles.bottomTabIndicator,
                    activeTab === "builds" && styles.bottomTabIndicatorActive,
                  ]}
                />
                <View style={styles.bottomTabLabelRow}>
                  <Text
                    style={[
                      styles.bottomTabText,
                      activeTab === "builds" && styles.bottomTabTextActive,
                    ]}
                  >
                    Builds
                  </Text>
                  {hasBuildBadge ? (
                    buildStatusCount > 0 ? (
                      <View style={styles.bottomTabBadge}>
                        <Text style={styles.bottomTabBadgeText}>{buildBadgeText}</Text>
                      </View>
                    ) : (
                      <View style={styles.bottomTabBadgeDot} />
                    )
                  ) : null}
                </View>
              </Pressable>
              <Pressable
                style={[styles.bottomTab, activeTab === "assistant" && styles.bottomTabActive]}
                onPress={() => setActiveTab("assistant")}
              >
                <View
                  style={[
                    styles.bottomTabIndicator,
                    activeTab === "assistant" && styles.bottomTabIndicatorActive,
                  ]}
                />
                <Text
                  style={[
                    styles.bottomTabText,
                    activeTab === "assistant" && styles.bottomTabTextActive,
                  ]}
                >
                  Assistant
                </Text>
              </Pressable>
              <Pressable
                style={[styles.bottomTab, activeTab === "activity" && styles.bottomTabActive]}
                onPress={() => setActiveTab("activity")}
              >
                <View
                  style={[
                    styles.bottomTabIndicator,
                    activeTab === "activity" && styles.bottomTabIndicatorActive,
                  ]}
                />
                <Text
                  style={[
                    styles.bottomTabText,
                    activeTab === "activity" && styles.bottomTabTextActive,
                  ]}
                >
                  Activity
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  screen: {
    flex: 1,
  },
  content: {
    padding: 20,
    gap: 18,
    paddingBottom: 120,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 34,
    color: THEME.colors.text,
    letterSpacing: 0.4,
  },
  subtitle: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 16,
    color: THEME.colors.muted,
    marginTop: 4,
  },
  statusButton: {
    padding: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(248, 250, 252, 0.35)",
    marginTop: 4,
  },
  statusIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  card: {
    backgroundColor: THEME.colors.card,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    gap: 12,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  cardHeaderText: {
    flex: 1,
    gap: 4,
  },
  section: {
    gap: 10,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  sectionTitle: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 14,
  },
  sectionMeta: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 12,
  },
  sectionAction: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
  },
  sectionActionText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.primary,
    fontSize: 11,
  },
  sectionActionTextDisabled: {
    color: THEME.colors.muted,
  },
  taskRow: {
    gap: 6,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(15, 23, 42, 0.55)",
  },
  taskHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  taskTitle: {
    flex: 1,
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 13,
  },
  taskMeta: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 11,
  },
  taskSub: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: "rgba(203, 213, 245, 0.75)",
    fontSize: 11,
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: "rgba(248, 250, 252, 0.15)",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
  },
  runConfigRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
  },
  runConfigInfo: {
    flex: 1,
    gap: 4,
  },
  runConfigName: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 13,
  },
  runConfigMeta: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 11,
  },
  runButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(248, 250, 252, 0.12)",
  },
  runButtonDisabled: {
    opacity: 0.5,
  },
  runButtonText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 12,
  },
  modalContainer: {
    flex: 1,
  },
  modalSafeArea: {
    flex: 1,
  },
  modalContent: {
    padding: 20,
    gap: 18,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  modalCloseButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
  },
  modalCloseText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.muted,
    fontSize: 12,
  },
  modalHint: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 13,
  },
  modalSubHint: {
    marginTop: 6,
  },
  cardTitle: {
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 18,
    color: THEME.colors.text,
  },
  input: {
    backgroundColor: THEME.colors.input,
    color: THEME.colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    fontFamily: "SpaceGrotesk_500Medium",
  },
  urlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  urlInput: {
    flex: 1,
  },
  qrPrimaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  qrPrimaryButtonText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 15,
  },
  qrIcon: {
    width: 18,
    height: 18,
    position: "relative",
  },
  qrIconFinder: {
    width: 8,
    height: 8,
    borderWidth: 2,
    borderColor: THEME.colors.text,
    borderRadius: 2,
    position: "absolute",
  },
  qrIconFinderTopLeft: {
    top: 0,
    left: 0,
  },
  qrIconFinderTopRight: {
    top: 0,
    right: 0,
  },
  qrIconFinderBottomLeft: {
    bottom: 0,
    left: 0,
  },
  qrIconDot: {
    width: 4,
    height: 4,
    backgroundColor: THEME.colors.text,
    borderRadius: 1,
    position: "absolute",
    right: 2,
    bottom: 2,
  },
  manualEntryHint: {
    marginTop: 8,
  },
  scannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  scannerBody: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 24,
    gap: 16,
  },
  scannerPreview: {
    flex: 1,
    borderRadius: 20,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
  },
  scannerCamera: {
    flex: 1,
  },
  scannerFrameOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  scannerFrame: {
    width: "70%",
    aspectRatio: 1,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: "rgba(248, 250, 252, 0.7)",
  },
  scannerFooter: {
    gap: 10,
    alignItems: "center",
  },
  scannerHint: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.text,
    fontSize: 13,
    textAlign: "center",
  },
  scanError: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.danger,
    fontSize: 12,
    textAlign: "center",
  },
  scannerPermission: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 20,
  },
  historyList: {
    gap: 10,
  },
  historyItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    overflow: "hidden",
  },
  historyItemMain: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 4,
  },
  historyUrl: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 13,
  },
  historyMeta: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 12,
  },
  historyDelete: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.6)",
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    marginRight: 10,
  },
  historyDeleteText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.danger,
    fontSize: 11,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
    flexWrap: "wrap",
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  buttonPrimary: {
    backgroundColor: THEME.colors.primary,
  },
  buttonSecondary: {
    backgroundColor: "rgba(248, 250, 252, 0.12)",
  },
  buttonGhost: {
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
  },
  buttonDisabled: {
    backgroundColor: THEME.colors.primaryDark,
    opacity: 0.6,
  },
  buttonText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 14,
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
  },
  statusMeta: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    marginLeft: 6,
  },
  muted: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
  },
  tabsRow: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 4,
  },
  tab: {
    minWidth: 140,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
    gap: 4,
  },
  tabActive: {
    borderColor: THEME.colors.primary,
    backgroundColor: "rgba(249, 115, 22, 0.18)",
  },
  tabTitle: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 13,
  },
  tabAdd: {
    minWidth: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  tabAddText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 20,
    lineHeight: 22,
  },
  outputScroll: {
    maxHeight: 240,
    backgroundColor: "#000",
    borderRadius: 12,
  },
  outputScrollContent: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  outputHorizontalContent: {
    alignItems: "flex-start",
  },
  outputText: {
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
    color: THEME.colors.text,
    fontSize: 11,
    lineHeight: 18,
  },
  outputCursor: {
    backgroundColor: THEME.colors.primary,
    color: "#0B0F1A",
  },
  commandBlock: {
    gap: 6,
  },
  commandRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  quickKeysToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  quickKeysToggle: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(15, 23, 42, 0.4)",
  },
  quickKeysToggleActive: {
    borderColor: THEME.colors.primary,
    backgroundColor: "rgba(249, 115, 22, 0.18)",
  },
  quickKeysToggleText: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.text,
    fontSize: 12,
  },
  quickKeysHint: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.warning,
    fontSize: 12,
  },
  quickKeysRow: {
    gap: 8,
    paddingVertical: 6,
  },
  quickKeyButton: {
    minWidth: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  quickKeyText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 13,
  },
  commandInput: {
    flex: 1,
  },
  micButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  micButtonActive: {
    borderColor: "rgba(239, 68, 68, 0.7)",
    backgroundColor: "rgba(239, 68, 68, 0.18)",
  },
  micIcon: {
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  micIconHead: {
    width: 14,
    height: 18,
    borderRadius: 7,
    borderWidth: 2,
  },
  micIconStem: {
    width: 2,
    height: 6,
    borderRadius: 1,
  },
  micIconBase: {
    width: 12,
    height: 2,
    borderRadius: 1,
  },
  commandButtonDisabled: {
    opacity: 0.5,
  },
  micStatusError: {
    color: THEME.colors.danger,
  },
  sessionActionRow: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  sessionActionButton: {
    flex: 1,
    alignItems: "center",
  },
  bottomBar: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 10,
  },
  bottomBarInner: {
    flexDirection: "row",
    backgroundColor: "rgba(11, 15, 26, 0.92)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.3)",
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 8,
  },
  bottomTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  bottomTabActive: {
    backgroundColor: "rgba(249, 115, 22, 0.18)",
  },
  bottomTabText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.muted,
    fontSize: 12,
  },
  bottomTabLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  bottomTabBadge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: THEME.colors.warning,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  bottomTabBadgeText: {
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 10,
    color: THEME.colors.backgroundBottom,
  },
  bottomTabBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: THEME.colors.warning,
  },
  bottomTabTextActive: {
    color: THEME.colors.text,
  },
  bottomTabIndicator: {
    width: 16,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(148, 163, 184, 0.5)",
  },
  bottomTabIndicatorActive: {
    backgroundColor: THEME.colors.primary,
  },
  logEntry: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    paddingVertical: 2,
  },
  buttonDangerOutline: {
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.7)",
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
});
