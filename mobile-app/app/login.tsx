import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Redirect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import {
  authSessionKey,
  fetchKotakAccounts,
  kotakAccountsKey,
  loginKotakWithTotp,
  positionsKey,
  underlyingsKey,
  verifyKotakMpin,
} from "@/lib/api";
import { normalizeApiUrl, normalizeWsUrl } from "@/lib/url";
import { palette, textStyles } from "@/lib/theme";
import { streamClient } from "@/lib/ws/stream-client";
import { useAuthStatus } from "@/hooks/use-auth-status";
import { useConnectionStore } from "@/stores/use-connection-store";

export default function LoginScreen() {
  const queryClient = useQueryClient();
  const config = useConnectionStore((state) => state.config);
  const setConfig = useConnectionStore((state) => state.setConfig);
  const { sessionState, isAuthenticated, apiReachable, refetch, isPending } = useAuthStatus();

  const [phase, setPhase] = useState<"totp" | "mpin">(sessionState === "totp_pending" ? "mpin" : "totp");
  const [totp, setTotp] = useState("");
  const [mpin, setMpin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiUrl, setApiUrl] = useState(config.apiUrl ?? "");
  const [wsUrl, setWsUrl] = useState(config.wsUrl ?? "");
  const [kotakMobile, setKotakMobile] = useState(config.kotakMobile ?? "");
  const [kotakUcc, setKotakUcc] = useState(config.kotakUcc ?? "");
  const [accountId, setAccountId] = useState(config.lastAccountId ?? "");

  // Server-side profiles keep the consumer key off the device; only when none
  // are configured does the backend fall back to our stored mobile/UCC.
  const accountsQuery = useQuery({
    queryKey: kotakAccountsKey(config.apiUrl),
    queryFn: fetchKotakAccounts,
    staleTime: 30_000,
  });
  // Memoised: the `?? []` fallback would otherwise hand the selection effect a
  // fresh array identity on every render and re-run it in a loop.
  const accountsData = accountsQuery.data;
  const accounts = useMemo(() => accountsData?.accounts ?? [], [accountsData]);
  const legacyMode = accountsData ? accounts.length === 0 : true;
  const brokerConfigured =
    !accountsData || accounts.length > 0 || accountsData.clientSuppliedIdentity;

  useEffect(() => {
    setApiUrl(config.apiUrl ?? "");
    setWsUrl(config.wsUrl ?? "");
    setKotakMobile(config.kotakMobile ?? "");
    setKotakUcc(config.kotakUcc ?? "");
  }, [config.apiUrl, config.kotakMobile, config.kotakUcc, config.wsUrl]);

  // Keep a valid selection: prefer the live account, then the remembered one.
  useEffect(() => {
    if (!accounts.length) return;
    const active = accountsData?.activeAccountId ?? "";
    setAccountId((current) => {
      if (current && accounts.some((a) => a.id === current)) return current;
      if (active && accounts.some((a) => a.id === active)) return active;
      const remembered = config.lastAccountId;
      if (remembered && accounts.some((a) => a.id === remembered)) return remembered;
      return accounts[0].id;
    });
  }, [accounts, accountsData?.activeAccountId, config.lastAccountId]);

  useEffect(() => {
    if (sessionState === "totp_pending") {
      setPhase("mpin");
    } else if (sessionState === "unauthenticated") {
      setPhase("totp");
    }
  }, [sessionState]);

  const missingConfig = useMemo(() => {
    if (!legacyMode) return [];
    const missing: string[] = [];
    if (!(kotakMobile ?? "").trim()) missing.push("Mobile Number");
    if (!(kotakUcc ?? "").trim()) missing.push("UCC");
    return missing;
  }, [kotakMobile, kotakUcc, legacyMode]);

  const blocked = missingConfig.length > 0 || !brokerConfigured || accountsQuery.isPending;

  const saveSettings = async () => {
    const normalizedApiUrl = normalizeApiUrl(apiUrl);
    const normalizedWsUrl = normalizeWsUrl(wsUrl || apiUrl);

    await setConfig({
      apiUrl: normalizedApiUrl,
      wsUrl: normalizedWsUrl,
      kotakMobile,
      kotakUcc,
      lastAccountId: accountId,
    });
    streamClient.forceReconnect();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: authSessionKey(normalizedApiUrl) }),
      queryClient.invalidateQueries({ queryKey: underlyingsKey }),
      queryClient.invalidateQueries({ queryKey: positionsKey }),
    ]);
    setShowSettings(false);
    Alert.alert("Saved", "Connection and broker settings updated.");
    await refetch();
  };

  const handleTotpLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await loginKotakWithTotp({
        totp,
        accountId: accountId || undefined,
        ...(legacyMode
          ? {
              mobile: (kotakMobile ?? "").trim(),
              ucc: (kotakUcc ?? "").trim().toUpperCase(),
            }
          : {}),
      });
      setPhase("mpin");
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setTotp("");
    } finally {
      setLoading(false);
    }
  };

  const handleMpinVerify = async () => {
    setError(null);
    setLoading(true);
    try {
      await verifyKotakMpin({ mpin, accountId: accountId || undefined });
      if (accountId && accountId !== config.lastAccountId) {
        await setConfig({ ...config, lastAccountId: accountId });
      }
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: underlyingsKey }),
        queryClient.invalidateQueries({ queryKey: positionsKey }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setMpin("");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (phase === "totp" && totp.length === 6 && !loading && !blocked) {
      void handleTotpLogin();
    }
  }, [totp]);

  useEffect(() => {
    if (phase === "mpin" && mpin.length === 6 && !loading) {
      void handleMpinVerify();
    }
  }, [mpin]);

  if (isPending) return null;
  if (isAuthenticated) {
    return <Redirect href="/(tabs)/chain" />;
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Kotak Neo</Text>
            <Text style={styles.subtitle}>
              {phase === "totp" ? "Enter TOTP to sign in" : "Enter your MPIN"}
            </Text>
          </View>
          <Pressable onPress={() => setShowSettings((value) => !value)} style={styles.settingsButton}>
            <Ionicons name="settings-outline" size={18} color={palette.muted} />
          </Pressable>
        </View>

        {!apiReachable ? (
          <View style={styles.warningCard}>
            <Text style={styles.warningTitle}>Backend unreachable</Text>
            <Text style={styles.warningBody}>
              Check your API URL and make sure the backend is running before attempting login.
            </Text>
            <Pressable onPress={() => void refetch()} style={styles.warningButton}>
              <Text style={styles.warningButtonText}>Retry connection</Text>
            </Pressable>
          </View>
        ) : null}

        {!brokerConfigured ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>No broker accounts configured</Text>
            <Text style={styles.errorBody}>
              Set KOTAK_ACCOUNTS (or KOTAK_CONSUMER_KEY) in the backend .env and restart it.
            </Text>
          </View>
        ) : null}

        {missingConfig.length ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Missing configuration</Text>
            <Text style={styles.errorBody}>Add these before signing in:</Text>
            <Text style={styles.errorList}>{missingConfig.join(", ")}</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {showSettings ? (
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>Connection & Broker Setup</Text>

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

            <Text style={styles.settingsNote}>
              {legacyMode
                ? "The backend has no account profiles, so it uses the mobile number and UCC below."
                : "Mobile and UCC come from the backend's KOTAK_ACCOUNTS profiles — the fields below are ignored."}
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

            <Pressable onPress={() => void saveSettings()} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Save Settings</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.loginCard}>
          {accounts.length > 0 ? (
            <>
              <Text style={styles.formLabel}>Account</Text>
              <View style={styles.accountList}>
                {accounts.map((account) => {
                  const active = account.id === accountId;
                  const locked = phase === "mpin" || loading;
                  return (
                    <Pressable
                      key={account.id}
                      disabled={locked}
                      onPress={() => {
                        setAccountId(account.id);
                        setError(null);
                      }}
                      style={[
                        styles.accountChip,
                        active && styles.accountChipActive,
                        locked && !active && styles.disabledButton,
                      ]}
                    >
                      <Text style={[styles.accountLabel, active && styles.accountLabelActive]}>
                        {account.label}
                      </Text>
                      <Text style={[styles.accountMeta, active && styles.accountMetaActive]}>
                        {[account.ucc, account.mobileMasked].filter(Boolean).join("  ·  ")}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          {phase === "totp" ? (
            <>
              <Text style={styles.formLabel}>TOTP</Text>
              <TextInput
                value={totp}
                onChangeText={(value) => setTotp(value.replace(/\D/g, "").slice(0, 6))}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                style={styles.authInput}
                placeholder="------"
                placeholderTextColor={palette.muted}
              />
              <Pressable
                onPress={() => void handleTotpLogin()}
                disabled={loading || totp.length < 6 || blocked}
                style={[styles.primaryButton, (loading || totp.length < 6 || blocked) && styles.disabledButton]}
              >
                {loading ? <ActivityIndicator color={palette.bg} /> : (
                  <Text style={styles.primaryButtonText}>Login with TOTP</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.formLabel}>MPIN</Text>
              <TextInput
                value={mpin}
                onChangeText={(value) => setMpin(value.replace(/\D/g, "").slice(0, 6))}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={6}
                autoFocus
                style={styles.authInput}
                placeholder="------"
                placeholderTextColor={palette.muted}
              />
              <Pressable
                onPress={() => void handleMpinVerify()}
                disabled={loading || mpin.length < 6}
                style={[styles.primaryButton, (loading || mpin.length < 6) && styles.disabledButton]}
              >
                {loading ? <ActivityIndicator color={palette.bg} /> : (
                  <Text style={styles.primaryButtonText}>Verify MPIN</Text>
                )}
              </Pressable>
              <Pressable onPress={() => {
                setPhase("totp");
                setMpin("");
              }} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Back to TOTP</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 28,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 18,
  },
  settingsButton: {
    width: 36,
    height: 36,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: palette.text,
    fontSize: 24,
    fontWeight: "800",
  },
  subtitle: {
    color: palette.muted,
    fontSize: 12,
    marginTop: 6,
  },
  warningCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#8d6b1d",
    backgroundColor: "#2c230f",
    padding: 14,
    marginBottom: 12,
  },
  warningTitle: {
    color: "#ffd271",
    fontSize: 13,
    fontWeight: "800",
  },
  warningBody: {
    color: "#f2d28b",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
  },
  warningButton: {
    alignSelf: "flex-start",
    marginTop: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#b28922",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  warningButtonText: {
    color: "#ffd271",
    fontSize: 11,
    fontWeight: "700",
  },
  errorCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#7d2c2c",
    backgroundColor: "#251214",
    padding: 14,
    marginBottom: 12,
  },
  errorTitle: {
    color: "#ff8d8d",
    fontSize: 13,
    fontWeight: "800",
  },
  errorBody: {
    color: "#ffb0b0",
    fontSize: 11,
    marginTop: 6,
  },
  errorList: {
    color: "#ffd0d0",
    fontSize: 11,
    marginTop: 6,
  },
  errorText: {
    color: "#ff9b9b",
    fontSize: 12,
  },
  settingsCard: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
  },
  settingsTitle: {
    color: palette.text,
    fontSize: 14,
    fontWeight: "800",
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
    marginBottom: 14,
    fontSize: 13,
  },
  settingsNote: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 12,
  },
  accountList: {
    gap: 8,
    marginBottom: 16,
  },
  accountChip: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.input,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  accountChipActive: {
    borderColor: palette.accent,
    backgroundColor: palette.accent,
  },
  accountLabel: {
    color: palette.text,
    fontSize: 13,
    fontWeight: "700",
  },
  accountLabelActive: {
    color: palette.bg,
  },
  accountMeta: {
    color: palette.muted,
    fontSize: 11,
    marginTop: 3,
  },
  accountMetaActive: {
    color: palette.bg,
    opacity: 0.75,
  },
  loginCard: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 20,
    padding: 18,
    marginTop: 8,
  },
  formLabel: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 8,
  },
  authInput: {
    backgroundColor: palette.input,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 15,
    color: palette.text,
    textAlign: "center",
    letterSpacing: 6,
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 14,
  },
  primaryButton: {
    backgroundColor: palette.accent,
    borderRadius: 16,
    alignItems: "center",
    paddingVertical: 15,
  },
  primaryButtonText: {
    color: palette.bg,
    fontSize: 14,
    fontWeight: "800",
  },
  secondaryButton: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 16,
    alignItems: "center",
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: "700",
  },
  disabledButton: {
    opacity: 0.5,
  },
});
