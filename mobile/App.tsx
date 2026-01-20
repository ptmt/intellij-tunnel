import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold, useFonts } from "@expo-google-fonts/space-grotesk";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  AppState,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AudioTranscription from "./AudioTranscription";
import { THEME } from "./theme";

type ConnectionState = "disconnected" | "connecting" | "connected";

type TerminalSession = {
  id: string;
  name: string;
  workingDirectory: string;
  createdAt: string;
};

type ConnectionHistoryItem = {
  id: string;
  serverUrl: string;
  pairingToken: string;
  lastUsed: string;
};

type AppTab = "terminal" | "transcribe" | "builds" | "activity";

type ServerMessage =
  | { type: "hello_ack"; deviceId: string }
  | { type: "approval_required"; message?: string }
  | { type: "approval_pending"; message?: string }
  | { type: "approval_granted"; deviceId?: string }
  | { type: "approval_denied"; message?: string }
  | { type: "sessions"; items: TerminalSession[] }
  | { type: "terminal_started"; session: TerminalSession }
  | { type: "terminal_output"; sessionId: string; output: string }
  | { type: "terminal_closed"; sessionId: string }
  | { type: "terminal_error"; message: string }
  | { type: "build_status"; status: string; message?: string }
  | { type: "error"; message?: string; code?: string };

const initialServerUrl = "ws://localhost:8765/ws";
const SESSION_POLL_MS = 6000;
const HISTORY_LIMIT = 6;
const STORAGE_KEYS = {
  serverUrl: "tunnel_server_url",
  pairingToken: "tunnel_pairing_token",
  sessions: "tunnel_sessions",
  activeSession: "tunnel_active_session",
  connectionHistory: "tunnel_connection_history",
  terminalOutputs: "tunnel_terminal_outputs",
};

export default function App() {
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
  });
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [pairingToken, setPairingToken] = useState<string>("");
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [connectionHistory, setConnectionHistory] = useState<ConnectionHistoryItem[]>([]);
  const [connectionModalVisible, setConnectionModalVisible] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [reconnectPending, setReconnectPending] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("terminal");
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [terminalOutputs, setTerminalOutputs] = useState<Record<string, string>>({});
  const [command, setCommand] = useState<string>("");
  const [buildStatus, setBuildStatus] = useState<string>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const shouldResumeReconnectRef = useRef(false);
  const reconnectBlockedRef = useRef<string | null>(null);
  const blockedTokenRef = useRef<string | null>(null);
  const blockNotifiedRef = useRef(false);
  const pendingSendsRef = useRef<Record<string, unknown>[]>([]);
  const connectionRef = useRef<ConnectionState>("disconnected");
  const serverUrlRef = useRef(serverUrl);
  const pairingTokenRef = useRef(pairingToken);
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

  const buildHistoryId = (url: string) => normalizeUrl(url).trim();
  const shouldForceConnectionModal =
    settingsReady && connectionHistory.length === 0 && connection !== "connected";
  const connectionModalOpen = connectionModalVisible || shouldForceConnectionModal;
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

  const pushLog = (entry: string) => {
    setLogs((prev) => [entry, ...prev].slice(0, 40));
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
    pushLog(`ws <= ${message.type}`);
  };

  const updateConnection = (next: ConnectionState) => {
    connectionRef.current = next;
    setConnection(next);
  };

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

  const isInvalidTokenText = (value?: string | null) => {
    if (!value) return false;
    const lower = value.toLowerCase();
    return lower.includes("invalid_token") || (lower.includes("invalid") && lower.includes("token"));
  };

  const isInvalidTokenCode = (value?: string) => {
    if (!value) return false;
    return value.toLowerCase() === "invalid_token";
  };

  const filterTerminalOutput = (value: string) => {
    const removeNeedle =
      "Unable to proceed. Could not locate working directory.: No such file or directory (os error 2)";
    return value
      .split(/\r?\n/)
      .filter((line) => !line.includes(removeNeedle))
      .join("\n");
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
      socket.send(JSON.stringify(helloPayload));
      logOutbound(helloPayload, false);
      socket.send(JSON.stringify(listPayload));
      logOutbound(listPayload, false);
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
        } else if (message.type === "terminal_closed") {
          setSessions((prev) => prev.filter((session) => session.id !== message.sessionId));
          setTerminalOutputs((prev) => {
            const next = { ...prev };
            delete next[message.sessionId];
            return next;
          });
          setActiveSessionId((current) => (current === message.sessionId ? null : current));
          setSessionsLoaded(true);
        } else if (message.type === "build_status") {
          setBuildStatus(message.status);
          if (message.message) {
            pushLog(`Build: ${message.message}`);
          }
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
    if (!activeSessionId) return;
    const data = command;
    if (!data.trim()) return;
    const payload = appendNewline ? `${data}\n` : data;
    send({ type: "terminal_input", sessionId: activeSessionId, data: payload });
    setCommand("");
    requestSnapshot(activeSessionId);
  };
  const submitCommand = () => sendCommand(true);
  const sendRawCommand = () => sendCommand(false);
  const triggerBuild = () => {
    if (connectionRef.current !== "connected") return;
    send({ type: "build_project" });
  };

  const displaySessions = canInteract || showCachedContent ? sessions : [];
  const displayActiveSessionId = canInteract || showCachedContent ? activeSessionId : null;
  const activeOutput = displayActiveSessionId ? terminalOutputs[displayActiveSessionId] ?? "" : "";
  const displayOutput = filterTerminalOutput(activeOutput);
  const activeSession = displayActiveSessionId
    ? displaySessions.find((session) => session.id === displayActiveSessionId) ?? null
    : null;
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
            <ScrollView contentContainerStyle={styles.modalContent}>
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
                {shouldForceConnectionModal ? (
                  <Text style={styles.modalHint}>Add a connection to get started.</Text>
                ) : null}
                <TextInput
                  style={styles.input}
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="ws://host:8765/ws"
                  placeholderTextColor="rgba(248, 250, 252, 0.4)"
                />
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
                  <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
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
                <View style={[styles.statusIndicator, { backgroundColor: statusColor }]} />
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
                    <View style={styles.outputHeader}>
                      <View style={styles.outputHeaderMeta}>
                        <Text style={styles.muted}>Session: {activeSession.name}</Text>
                        <Text style={styles.outputPath} numberOfLines={1}>
                          {activeSession.workingDirectory}
                        </Text>
                      </View>
                      {canInteract ? (
                        <Pressable
                          style={[styles.button, styles.buttonDangerOutline]}
                          onPress={() => closeSession(activeSession.id)}
                        >
                          <Text style={styles.buttonText}>Close</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    <ScrollView
                      style={styles.outputScroll}
                      contentContainerStyle={styles.outputScrollContent}
                      nestedScrollEnabled
                    >
                      <Text style={styles.outputText}>{displayOutput || "No output yet."}</Text>
                    </ScrollView>
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
                        editable={canInteract}
                        selectTextOnFocus={canInteract}
                      />
                      <Pressable
                        style={[
                          styles.micButton,
                          (!canInteract || !command.trim()) && styles.commandButtonDisabled,
                        ]}
                        onPress={sendRawCommand}
                        disabled={!canInteract || !command.trim()}
                      >
                        <Text style={styles.micButtonText}>Type</Text>
                      </Pressable>
                      <Pressable
                        style={[
                          styles.button,
                          styles.buttonPrimary,
                          (!canInteract || !command.trim()) && styles.buttonDisabled,
                        ]}
                        onPress={submitCommand}
                        disabled={!canInteract || !command.trim()}
                      >
                        <Text style={styles.buttonText}>Send</Text>
                      </Pressable>
                    </View>
                    {canInteract ? (
                      <Pressable
                        style={[styles.button, styles.buttonSecondary]}
                        onPress={() => requestSnapshot(activeSession.id)}
                      >
                        <Text style={styles.buttonText}>Refresh output</Text>
                      </Pressable>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.muted}>{emptyTerminalMessage}</Text>
                )}
              </View>
            ) : null}

            {activeTab === "transcribe" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Transcription</Text>
                <Text style={styles.muted}>On-device Whisper with live microphone input.</Text>
                <AudioTranscription />
              </View>
            ) : null}

            {activeTab === "builds" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Builds</Text>
                <Text style={styles.muted}>Status: {buildStatus}</Text>
                <Pressable style={[styles.button, styles.buttonPrimary]} onPress={triggerBuild}>
                  <Text style={styles.buttonText}>Run build</Text>
                </Pressable>
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
                style={[styles.bottomTab, activeTab === "transcribe" && styles.bottomTabActive]}
                onPress={() => setActiveTab("transcribe")}
              >
                <View
                  style={[
                    styles.bottomTabIndicator,
                    activeTab === "transcribe" && styles.bottomTabIndicatorActive,
                  ]}
                />
                <Text
                  style={[
                    styles.bottomTabText,
                    activeTab === "transcribe" && styles.bottomTabTextActive,
                  ]}
                >
                  Transcribe
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
                <Text
                  style={[
                    styles.bottomTabText,
                    activeTab === "builds" && styles.bottomTabTextActive,
                  ]}
                >
                  Builds
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
  outputHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  outputHeaderMeta: {
    flex: 1,
    gap: 2,
  },
  outputPath: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 12,
  },
  outputScroll: {
    maxHeight: 240,
  },
  outputScrollContent: {
    padding: 0,
  },
  outputText: {
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
    color: THEME.colors.text,
    fontSize: 12,
    lineHeight: 18,
  },
  commandRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
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
  micButtonText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 12,
  },
  commandButtonDisabled: {
    opacity: 0.5,
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
