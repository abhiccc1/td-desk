import { StyleSheet, Text, View } from "react-native";

import { palette, textStyles } from "@/lib/theme";

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={textStyles.subtle}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 18,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    padding: 18,
    marginVertical: 12,
    gap: 8,
  },
  title: {
    color: palette.text,
    fontSize: 15,
    fontWeight: "700",
  },
});
