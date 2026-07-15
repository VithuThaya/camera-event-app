import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phone testing runs through a Cloudflare quick tunnel, because the camera
  // needs a secure context and the LAN address cannot give us one.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
