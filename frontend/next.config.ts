import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Allow the dev server to be reached from other devices on the LAN.
  allowedDevOrigins: ["192.168.88.241", "td.desk"],
};

export default nextConfig;
