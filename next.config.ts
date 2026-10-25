import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/Node-only packages stay out of the server bundle.
  serverExternalPackages: ["exceljs", "unpdf", "pdf-lib", "stripe"],
  experimental: {
    serverActions: { bodySizeLimit: "40mb" },
  },
  poweredByHeader: false,
};

export default nextConfig;
