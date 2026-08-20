import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Dev-server origins allowed to load /_next assets.
   *
   * next dev refuses cross-origin requests for its static chunks unless the origin is listed here.
   * Opening the app on the LAN address instead of localhost returned 200 for the HTML and for every
   * API route, but 403 for /_next/static/chunks/*, so the client bundle never arrived, React never
   * hydrated, and pages sat on their server-rendered skeleton forever — which reads exactly like a
   * hung fetch. Listing the LAN address fixes browsing from a phone or a second machine.
   *
   * Dev only: next start does not apply this check, and it grants nothing beyond serving dev assets.
   */
  allowedDevOrigins: ["192.168.1.73"],
};

export default nextConfig;
