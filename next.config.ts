import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phone testing runs through a Cloudflare quick tunnel, because the camera
  // needs a secure context and the LAN address cannot give us one.
  allowedDevOrigins: ["*.trycloudflare.com"],
  // Hide the Next.js dev indicator (the corner "N" that opens a Route/Bundler
  // menu). Testing runs the dev server through the tunnel, so a guest would see
  // — and could poke at — dev tooling meant for us. It never appears in a
  // production build; this only affects `next dev`. Errors still surface.
  devIndicators: false,
};

export default nextConfig;
