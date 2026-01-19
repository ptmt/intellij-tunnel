import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold, useFonts } from "@expo-google-fonts/space-grotesk";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  AppState,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type ConnectionState = "disconnected" | "connecting" | "connected";

type TerminalSession = {
  id: string;
  name: string;
  workingDirectory: string;
  createdAt: string;
};

type ServerMessage =
  | { type: "hello_ack"; deviceId: string }
  | { type: "sessions"; items: TerminalSession[] }
  | { type: "terminal_started"; session: TerminalSession }
  | { type: "terminal_output"; sessionId: string; output: string }
  | { type: "terminal_closed"; sessionId: string }
  | { type: "terminal_error"; message: string }
  | { type: "build_status"; status: string; message?: string }
  | { type: "error"; message: string };

const THEME = {
  colors: {
    backgroundTop: "#0B1221",
    backgroundMid: "#12264D",
    backgroundBottom: "#0B0F1A",
    card: "rgba(255, 255, 255, 0.08)",
    cardBorder: "rgba(255, 255, 255, 0.15)",
    primary: "#F97316",
    primaryDark: "#C2410C",
    text: "#F8FAFC",
    muted: "#CBD5F5",
    input: "#0F172A",
    success: "#22C55E",
    warning: "#F59E0B",
    danger: "#EF4444",
  },
};

const initialServerUrl = "ws://localhost:8765/ws";

export default function App() {
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
  });
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [deviceId, setDeviceId] = useState<string | null>(null);
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
  const pendingSendsRef = useRef<Record<string, unknown>[]>([]);
  const connectionRef = useRef<ConnectionState>("disconnected");
  const serverUrlRef = useRef(serverUrl);
  const appStateRef = useRef(AppState.currentState);

  const statusLabel = useMemo(() => {
    switch (connection) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting";
      default:
        return "Disconnected";
    }
  }, [connection]);

  const statusColor = useMemo(() => {
    switch (connection) {
      case "connected":
        return THEME.colors.success;
      case "connecting":
        return THEME.colors.warning;
      default:
        return THEME.colors.danger;
    }
  }, [connection]);

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
    serverUrlRef.current = serverUrl;
  }, [serverUrl]);

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
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    if (!sessions.some((session) => session.id === activeSessionId)) {
      setActiveSessionId(null);
    }
  }, [activeSessionId, sessions]);

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

  const clearReconnectTimer = () => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  };

  const scheduleReconnect = () => {
    if (!shouldReconnectRef.current) return;
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
    shouldReconnectRef.current = true;
    clearReconnectTimer();
    const rawUrl = serverUrlRef.current;
    const normalized = normalizeUrl(rawUrl);
    if (normalized !== rawUrl) {
      setServerUrl(normalized);
    }

    pushLog(`Connecting to ${normalized}`);
    updateConnection("connecting");
    const socket = new WebSocket(normalized);
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      updateConnection("connected");
      reconnectAttemptsRef.current = 0;
      const deviceName = `${Platform.OS}-mobile`;
      const helloPayload = { type: "hello", deviceName };
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
        } else if (message.type === "sessions") {
          setSessions(message.items);
        } else if (message.type === "terminal_started") {
          setSessions((prev) => [...prev, message.session]);
          setActiveSessionId(message.session.id);
          send({ type: "terminal_snapshot", sessionId: message.session.id, lines: 200 });
          pushLog(`Terminal started: ${message.session.name}`);
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
        } else if (message.type === "build_status") {
          setBuildStatus(message.status);
          if (message.message) {
            pushLog(`Build: ${message.message}`);
          }
        } else if (message.type === "terminal_error") {
          pushLog(`Terminal: ${message.message}`);
        } else if (message.type === "error") {
          pushLog(`Server error: ${message.message}`);
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
      setSessions([]);
      setActiveSessionId(null);
      setTerminalOutputs({});
      const reason = event.reason ? `: ${event.reason}` : "";
      pushLog(`Socket disconnected (${event.code}${reason})`);
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
    reconnectAttemptsRef.current = 0;
    clearReconnectTimer();
    pendingSendsRef.current = [];
    socketRef.current?.close();
    socketRef.current = null;
    updateConnection("disconnected");
    setSessions([]);
    setActiveSessionId(null);
    setTerminalOutputs({});
  };

  const send = (payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      queueSend(payload);
      if (connectionRef.current === "disconnected") {
        connect();
      }
      return;
    }
    socket.send(JSON.stringify(payload));
    logOutbound(payload, false);
  };

  const requestSessions = () => send({ type: "list_sessions" });
  const startSession = () => send({ type: "start_terminal" });
  const closeSession = (sessionId: string) => send({ type: "close_terminal", sessionId });
  const requestSnapshot = (sessionId: string) => send({ type: "terminal_snapshot", sessionId, lines: 200 });
  const sendCommand = () => {
    if (!activeSessionId) return;
    const trimmed = command.trim();
    if (!trimmed) return;
    send({ type: "terminal_input", sessionId: activeSessionId, data: `${trimmed}\\n` });
    setCommand("");
    requestSnapshot(activeSessionId);
  };
  const triggerBuild = () => send({ type: "build_project" });

  const activeOutput = activeSessionId ? terminalOutputs[activeSessionId] ?? "" : "";
  const activeSession = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId) ?? null
    : null;

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
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>IntelliJ Tunnel</Text>
          <Text style={styles.subtitle}>Pair to your IDE and keep builds in your pocket.</Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Connection</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="ws://host:8765/ws"
              placeholderTextColor="rgba(248, 250, 252, 0.4)"
            />
            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.button, styles.buttonPrimary, connection !== "disconnected" && styles.buttonDisabled]}
                onPress={connect}
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
            <Text style={styles.cardTitle}>Terminal sessions</Text>
            <View style={styles.buttonRow}>
              <Pressable style={[styles.button, styles.buttonSecondary]} onPress={requestSessions}>
                <Text style={styles.buttonText}>Refresh</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.buttonSecondary]} onPress={startSession}>
                <Text style={styles.buttonText}>New session</Text>
              </Pressable>
            </View>
            {sessions.length === 0 ? (
              <Text style={styles.muted}>No sessions reported yet.</Text>
            ) : (
              sessions.map((session) => (
                <View key={session.id} style={styles.sessionRow}>
                  <View style={styles.sessionMeta}>
                    <Text style={styles.sessionName}>{session.name}</Text>
                    <Text style={styles.sessionDetail}>{session.workingDirectory}</Text>
                  </View>
                  <View style={styles.sessionActions}>
                    <Pressable
                      style={[
                        styles.chip,
                        activeSessionId === session.id && styles.chipActive,
                      ]}
                      onPress={() => {
                        setActiveSessionId(session.id);
                        requestSnapshot(session.id);
                      }}
                    >
                      <Text style={styles.chipText}>
                        {activeSessionId === session.id ? "Viewing" : "View"}
                      </Text>
                    </Pressable>
                    <Pressable style={[styles.chip, styles.chipDanger]} onPress={() => closeSession(session.id)}>
                      <Text style={styles.chipText}>Close</Text>
                    </Pressable>
                  </View>
                </View>
              ))
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Terminal output</Text>
            {activeSession ? (
              <>
                <Text style={styles.muted}>Session: {activeSession.name}</Text>
                <View style={styles.outputBox}>
                  <Text style={styles.outputText}>{activeOutput || "No output yet."}</Text>
                </View>
                <View style={styles.commandRow}>
                  <TextInput
                    style={[styles.input, styles.commandInput]}
                    value={command}
                    onChangeText={setCommand}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Enter command"
                    placeholderTextColor="rgba(248, 250, 252, 0.4)"
                  />
                  <Pressable
                    style={[styles.button, styles.buttonPrimary, !command.trim() && styles.buttonDisabled]}
                    onPress={sendCommand}
                  >
                    <Text style={styles.buttonText}>Send</Text>
                  </Pressable>
                </View>
                <Pressable style={[styles.button, styles.buttonSecondary]} onPress={() => requestSnapshot(activeSession.id)}>
                  <Text style={styles.buttonText}>Refresh output</Text>
                </Pressable>
              </>
            ) : (
              <Text style={styles.muted}>Select a session to view output.</Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Build</Text>
            <Text style={styles.muted}>Status: {buildStatus}</Text>
            <Pressable style={[styles.button, styles.buttonPrimary]} onPress={triggerBuild}>
              <Text style={styles.buttonText}>Run build</Text>
            </Pressable>
          </View>

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
        </ScrollView>
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
  content: {
    padding: 20,
    gap: 18,
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
  card: {
    backgroundColor: THEME.colors.card,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
    gap: 12,
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
  sessionRow: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(248, 250, 252, 0.08)",
    gap: 8,
  },
  sessionMeta: {
    gap: 2,
  },
  sessionName: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 15,
  },
  sessionDetail: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 12,
  },
  sessionActions: {
    flexDirection: "row",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.colors.cardBorder,
  },
  chipActive: {
    backgroundColor: "rgba(249, 115, 22, 0.2)",
    borderColor: THEME.colors.primary,
  },
  chipDanger: {
    borderColor: "rgba(239, 68, 68, 0.6)",
  },
  chipText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 12,
  },
  outputBox: {
    backgroundColor: "rgba(15, 23, 42, 0.9)",
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.2)",
    maxHeight: 240,
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
  logEntry: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    paddingVertical: 2,
  },
});
