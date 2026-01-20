import React, { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { AudioManager, AudioRecorder } from "react-native-audio-api";
import { useSpeechToText, WHISPER_TINY_EN } from "react-native-executorch";
import { THEME } from "./theme";

const SAMPLE_RATE = 16000;
const BUFFER_LENGTH_IN_SAMPLES = 1600;

const formatPercent = (value: number | null | undefined) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "0%";
  return `${Math.round(value * 100)}%`;
};

export default function AudioTranscription() {
  const model = useSpeechToText({
    model: WHISPER_TINY_EN,
  });
  const recorderRef = useRef<AudioRecorder | null>(null);
  const streamingRef = useRef(false);
  const [permissionState, setPermissionState] = useState<"unknown" | "granted" | "denied">("unknown");
  const [recorderReady, setRecorderReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensurePermissions = useCallback(async () => {
    if (permissionState === "granted") return true;
    try {
      const result = await AudioManager.requestRecordingPermissions();
      if (result === "Granted") {
        setPermissionState("granted");
        return true;
      }
      if (result === "Denied") {
        setPermissionState("denied");
        return false;
      }
      setPermissionState("unknown");
      return false;
    } catch {
      setPermissionState("denied");
      return false;
    }
  }, [permissionState]);

  const handleStopStreaming = useCallback(() => {
    streamingRef.current = false;
    try {
      recorderRef.current?.stop();
    } catch {
      // Ignore stop errors.
    }
    try {
      model.streamStop();
    } catch {
      // Ignore stream stop errors.
    }
  }, [model]);

  const handleStartStreaming = useCallback(async () => {
    if (model.isGenerating) return;
    setError(null);
    const allowed = await ensurePermissions();
    if (!allowed) {
      setError("Microphone permission is required to start transcription.");
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder) {
      setError("Recorder is not ready yet.");
      return;
    }

    streamingRef.current = true;
    recorder.onAudioReady(({ buffer }) => {
      if (!streamingRef.current) return;
      try {
        const samples = Array.from(buffer.getChannelData(0));
        model.streamInsert(samples);
      } catch (streamError) {
        setError("Audio buffer processing failed.");
        handleStopStreaming();
      }
    });

    try {
      recorder.start();
    } catch {
      setError("Failed to start the audio recorder.");
      streamingRef.current = false;
      return;
    }

    try {
      await model.stream();
    } catch (streamError) {
      setError("Transcription error. Please try again.");
      handleStopStreaming();
    }
  }, [ensurePermissions, handleStopStreaming, model]);

  useEffect(() => {
    const recorder = new AudioRecorder({
      sampleRate: SAMPLE_RATE,
      bufferLengthInSamples: BUFFER_LENGTH_IN_SAMPLES,
    });
    recorderRef.current = recorder;
    setRecorderReady(true);

    if (Platform.OS === "ios") {
      AudioManager.setAudioSessionOptions({
        iosCategory: "playAndRecord",
        iosMode: "spokenAudio",
        iosOptions: ["allowBluetooth", "defaultToSpeaker"],
      });
    }

    void ensurePermissions();

    return () => {
      streamingRef.current = false;
      try {
        recorder.stop();
      } catch {
        // Ignore stop errors on teardown.
      }
      try {
        model.streamStop();
      } catch {
        // Ignore stream stop errors on teardown.
      }
      recorderRef.current = null;
    };
  }, [ensurePermissions, model]);

  const canStart = model.isReady && recorderReady && permissionState !== "denied";
  const isDisabled = model.isGenerating ? false : !canStart;
  const hasTranscript = Boolean(model.committedTranscription || model.nonCommittedTranscription);

  return (
    <View style={styles.container}>
      {!model.isReady ? (
        <View style={styles.loadingBlock}>
          <Text style={styles.label}>Loading Whisper model...</Text>
          <Text style={styles.muted}>{formatPercent(model.downloadProgress)}</Text>
        </View>
      ) : (
        <>
          {hasTranscript ? (
            <Text style={styles.transcriptionText}>
              {model.committedTranscription}
              {model.committedTranscription ? " " : ""}
              <Text style={styles.transcriptionMuted}>{model.nonCommittedTranscription}</Text>
            </Text>
          ) : (
            <Text style={styles.muted}>Tap Start Recording to begin transcription.</Text>
          )}
        </>
      )}

      {permissionState === "denied" ? (
        <Text style={styles.errorText}>Microphone permission denied. Enable it in settings.</Text>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.controls}>
        <Pressable
          style={[
            styles.button,
            model.isGenerating ? styles.buttonDanger : styles.buttonPrimary,
            isDisabled && styles.buttonDisabled,
          ]}
          onPress={model.isGenerating ? handleStopStreaming : handleStartStreaming}
          disabled={isDisabled}
        >
          <Text style={styles.buttonText}>
            {model.isGenerating ? "Stop Recording" : "Start Recording"}
          </Text>
        </Pressable>
        <Text style={styles.muted}>{model.isGenerating ? "Listening..." : "Idle"}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  loadingBlock: {
    gap: 4,
  },
  label: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 14,
  },
  muted: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 12,
  },
  transcriptionText: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  transcriptionMuted: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontStyle: "italic",
  },
  errorText: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.danger,
    fontSize: 12,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  buttonPrimary: {
    backgroundColor: THEME.colors.primary,
  },
  buttonDanger: {
    backgroundColor: THEME.colors.danger,
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
});
