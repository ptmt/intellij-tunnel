import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { THEME } from "./theme";

export default function VoiceAssistant() {
  return (
    <View style={styles.container}>
      <Text style={styles.muted}>Available only in iOS/Android.</Text>
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
