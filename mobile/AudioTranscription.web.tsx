import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { THEME } from "./theme";

export default function AudioTranscription() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Device-only feature</Text>
      <Text style={styles.body}>
        Audio transcription runs on iOS and Android builds. The web version does not support the
        required native audio and ExecuTorch modules.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  title: {
    fontFamily: "SpaceGrotesk_700Bold",
    color: THEME.colors.text,
    fontSize: 14,
  },
  body: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
});
