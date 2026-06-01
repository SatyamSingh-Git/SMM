import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow loading the dashboard from this machine's LAN IP (e.g. from a phone
  // on the same Wi-Fi). Localhost is allowed by default.
  allowedDevOrigins: ["192.168.56.1", "192.168.*.*"],
};

export default nextConfig;
