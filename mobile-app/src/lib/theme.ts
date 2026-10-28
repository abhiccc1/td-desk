export const palette = {
  bg: "#071018",
  panel: "#0d1722",
  input: "#132030",
  border: "#203246",
  text: "#eef4ff",
  muted: "#95a8bf",
  accent: "#1f8bff",
  accentSoft: "#7cc4ff",
  danger: "#ff6b6b",
  success: "#46d39a",
};

export const textStyles = {
  eyebrow: {
    color: palette.accentSoft,
    fontSize: 10,
    fontWeight: "700" as const,
    letterSpacing: 0.7,
    marginBottom: 6,
    textTransform: "uppercase" as const,
  },
  title: {
    color: palette.text,
    fontSize: 22,
    fontWeight: "800" as const,
    marginBottom: 6,
  },
  subtle: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 14,
  },
  label: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: "700" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
};
