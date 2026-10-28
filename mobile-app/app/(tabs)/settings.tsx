import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, type Href } from "expo-router";

import { Screen } from "@/components/screen";
import { SectionCard } from "@/components/section-card";
import {
  authSessionKey,
  fetchKotakAccounts,
  kotakAccountsKey,
  logoutKotak,
  positionsKey,
  underlyingsKey,
} from "@/lib/api";
import { useAuthStatus } from "@/hooks/use-auth-status";
import { normalizeApiUrl, normalizeWsUrl } from "@/lib/url";
import { palette, textStyles } from "@/lib/theme";
import { streamClient } from "@/lib/ws/stream-client";
import { useConnectionStore } from "@/stores/use-connection-store";

export default function SettingsScreen() {
  const queryClient = useQueryClient();
  const { sessionState, data: sessionInfo, refetch, accountId, ucc } = useAuthStatus();
  const config = useConnectionStore((state) => state.config);
  const setConfig = useConnectionStore((state) => state.setConfig);
  const [apiUrl, setApiUrl] = useState(config.apiUrl ?? "");
  const [wsUrl, setWsUrl] = useState(config.wsUrl ?? "");
  const [kotakMobile, setKotakMobile] = useState(config.kotakMobile ?? "");
  const [kotakUcc, setKotakUcc] = useState(config.kotakUcc ?? "");

  const accountsQuery = useQuery({
    queryKey: kotakAccountsKey(config.apiUrl),
    queryFn: fetchKotakAccounts,
    staleTime: 30_000,
  });
  const accounts = accountsQuery.data?.accounts ?? [];
  const activeAccount = accounts.find((account) => account.id === accountId);
  // Fall back to the raw UCC when no profile matches (legacy single-account login).
  const activeAccountName = activeAccount?.label || ucc || "";
  const canSwitch = sessionState === "authenticated" && accounts.length > 0;

  useEffect(() => {
    setApiUrl(config.apiUrl ?? "");
    setWsUrl(config.wsUrl ?? "");
    setKotakMobile(config.kotakMobile ?? "");
    setKotakUcc(config.kotakUcc ?? "");
  }, [config.apiUrl, config.kotakMobile, config.kotakUcc, config.wsUrl]);

  const save = async () => {
    const normalizedApiUrl = normalizeApiUrl(apiUrl);
    const normalizedWsUrl = normalizeWsUrl(wsUrl || apiUrl);
    await setConfig({
      apiUrl: normalizedApiUrl,
      wsUrl: normalizedWsUrl,
      kotakMobile,
      kotakUcc,
      lastAccountId: config.lastAccountId,
    });
    streamClient.forceReconnect();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: underlyingsKey }),
      queryClient.invalidateQueries({ queryKey: positionsKey }),
      queryClient.invalidateQueries({ queryKey: authSessionKey(normalizedApiUrl) }),
    ]);
    Alert.alert("Saved", "Connection settings updated.");
  };

  const clearSession = async () => {
    await logoutKotak();
    streamClient.forceReconnect();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: authSessionKey(config.apiUrl) }),
      queryClient.invalidateQueries({ queryKey: kotakAccountsKey(config.apiUrl) }),
      queryClient.invalidateQueries({ queryKey: underlyingsKey }),
      queryClient.invalidateQueries({ queryKey: positionsKey }),
    ]);
    await refetch();
  };

  const logout = async () => {
    try {
      await clearSession();
      Alert.alert("Logged out", "Broker session cleared.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Logout failed";
      Alert.alert("Logout failed", message);
    }
  };

  /** Switching is a logout plus a trip back to the picker.
   *
   * Only one broker account can be live at a time — the backend holds a single
   * set of credentials — so the previous session must end before another begins.
   */
  const switchAccount = async () => {
    try {
      await clearSession();
      router.replace("/login" as Href);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not switch account";
      Alert.alert("Switch failed", message);
    }
  };

  return (
    <Screen>
      <Text style={textStyles.subtle}>
        Use your backend machine LAN IP, for example `http://192.168.x.x:8000` and `ws://192.168.x.x:8000/ws/stream`.
      </Text>

      <SectionCard>
        <View style={styles.sessionHeader}>
          <View>
            <Text style={styles.sessionLabel}>Broker Session</Text>
            <Text style={styles.sessionValue}>
              {formatSessionState(sessionState)}
            </Text>
          </View>
          <View style={[styles.sessionBadge, badgeStyleForState(sessionState)]}>
            <Text style={[styles.sessionBadgeText, badgeTextStyleForState(sessionState)]}>
              {formatSessionState(sessionState)}
            </Text>
          </View>
        </View>
        {activeAccountName ? (
          <View style={styles.accountRow}>
            <Text style={styles.accountName}>{activeAccountName}</Text>
            {activeAccount?.ucc && activeAccount.ucc !== activeAccountName ? (
              <Text style={styles.accountUcc}>{activeAccount.ucc}</Text>
            ) : null}
          </View>
        ) : null}
        {sessionInfo?.authenticatedAt ? (
          <Text style={styles.sessionMeta}>Authenticated at {formatSessionTime(sessionInfo.authenticatedAt)}</Text>
        ) : null}
        {sessionInfo?.lastHealthCheck ? (
          <Text style={styles.sessionMeta}>Last health check {formatSessionTime(sessionInfo.lastHealthCheck)}</Text>
        ) : null}
      </SectionCard>

      <SectionCard>
        <Text style={styles.fieldLabel}>API URL</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          value={apiUrl}
          onChangeText={setApiUrl}
          style={styles.input}
          placeholder="http://192.168.1.40:8000"
          placeholderTextColor={palette.muted}
        />

        <Text style={styles.fieldLabel}>WebSocket URL</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          value={wsUrl}
          onChangeText={setWsUrl}
          style={styles.input}
          placeholder="ws://192.168.1.40:8000/ws/stream"
          placeholderTextColor={palette.muted}
        />

        <Text style={styles.legacyNote}>
          Fallback identity for login. Ignored when the backend has KOTAK_ACCOUNTS
          profiles — those supply the mobile number and UCC, and the login screen
          shows an account picker instead.
        </Text>

        <Text style={styles.fieldLabel}>Kotak Mobile</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          value={kotakMobile}
          onChangeText={setKotakMobile}
          style={styles.input}
          placeholder="+919876543210"
          placeholderTextColor={palette.muted}
        />

        <Text style={styles.fieldLabel}>Kotak UCC</Text>
        <TextInput
          autoCapitalize="characters"
          autoCorrect={false}
          value={kotakUcc}
          onChangeText={setKotakUcc}
          style={styles.input}
          placeholder="ABCDE"
          placeholderTextColor={palette.muted}
        />
      </SectionCard>

      <Pressable style={styles.button} onPress={save}>
        <Text style={styles.buttonText}>Save and Reconnect</Text>
      </Pressable>

      {canSwitch ? (
        <Pressable
          style={[styles.button, styles.switchButton]}
          onPress={() => {
            Alert.alert(
              "Switch account",
              activeAccountName
                ? `Sign out of ${activeAccountName} and choose a different account?`
                : "Sign out and choose a different account?",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Switch", onPress: () => { void switchAccount(); } },
              ],
            );
          }}
        >
          <Text style={styles.switchButtonText}>Switch Account</Text>
        </Pressable>
      ) : null}

      <Pressable
        style={[styles.button, styles.logoutButton]}
        onPress={() => {
          Alert.alert(
            "Logout",
            "Log out of the current Kotak session on the backend?",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Logout", style: "destructive", onPress: () => { void logout(); } },
            ],
          );
        }}
      >
        <Text style={styles.logoutButtonText}>Logout</Text>
      </Pressable>
    </Screen>
  );
}

function formatSessionState(state: string) {
  if (state === "authenticated") return "Active";
  if (state === "totp_pending") return "TOTP Pending";
  if (state === "unauthenticated") return "Logged Out";
  return "Unknown";
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function badgeStyleForState(state: string) {
  if (state === "authenticated") return styles.sessionBadgeActive;
  if (state === "totp_pending") return styles.sessionBadgePending;
  return styles.sessionBadgeInactive;
}

function badgeTextStyleForState(state: string) {
  if (state === "authenticated") return styles.sessionBadgeTextActive;
  if (state === "totp_pending") return styles.sessionBadgeTextPending;
  return styles.sessionBadgeTextInactive;
}

const styles = StyleSheet.create({
  sessionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sessionLabel: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  sessionValue: {
    color: palette.text,
    fontSize: 15,
    fontWeight: "800",
    marginTop: 6,
  },
  sessionMeta: {
    color: palette.muted,
    fontSize: 11,
    marginTop: 6,
  },
  sessionBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sessionBadgeActive: {
    borderColor: "#1f8d66",
    backgroundColor: "#10241b",
  },
  sessionBadgePending: {
    borderColor: "#a37c21",
    backgroundColor: "#2a2210",
  },
  sessionBadgeInactive: {
    borderColor: "#7d3a3a",
    backgroundColor: "#251314",
  },
  sessionBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sessionBadgeTextActive: {
    color: "#56d7a2",
  },
  sessionBadgeTextPending: {
    color: "#f3c96d",
  },
  sessionBadgeTextInactive: {
    color: "#ff9797",
  },
  legacyNote: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 12,
  },
  fieldLabel: {
    ...textStyles.label,
    marginBottom: 8,
  },
  input: {
    backgroundColor: palette.input,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: palette.text,
    marginBottom: 16,
  },
  button: {
    backgroundColor: palette.accent,
    borderRadius: 16,
    alignItems: "center",
    paddingVertical: 15,
  },
  buttonText: {
    color: palette.bg,
    fontSize: 14,
    fontWeight: "800",
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    marginTop: 10,
  },
  accountName: {
    color: palette.text,
    fontSize: 14,
    fontWeight: "700",
  },
  accountUcc: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "600",
  },
  switchButton: {
    marginTop: 12,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
  },
  switchButtonText: {
    color: palette.text,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  logoutButton: {
    marginTop: 12,
    backgroundColor: "#251314",
    borderWidth: 1,
    borderColor: "#7d3a3a",
  },
  logoutButtonText: {
    color: "#ff9797",
    fontSize: 14,
    fontWeight: "800",
  },
});
