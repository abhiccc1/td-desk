import type { PropsWithChildren, ReactElement } from "react";
import type { RefreshControlProps } from "react-native";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { palette } from "@/lib/theme";

export function Screen({
  children,
  refreshControl,
  scrollEnabled = true,
}: PropsWithChildren<{ refreshControl?: ReactElement<RefreshControlProps>; scrollEnabled?: boolean }>) {
  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      {scrollEnabled ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.content}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  scroll: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 18,
    backgroundColor: palette.bg,
  },
});
