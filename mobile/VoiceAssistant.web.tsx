import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { THEME } from "./theme";

export default function VoiceAssistant() {
  return (
    <View style={styles.container}>
      <Text style={styles.muted}>
        Voice assistant is available in iOS/Android dev builds. Expo Go and the web build do not
        include the required WebRTC modules.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  muted: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: THEME.colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
});
