import vinext from "vinext";
import { writing } from "./build/writing";
import { finance } from "./build/finance";
import { health } from "./build/health";
import { climbing } from "./build/climbing";
import { chess } from "./build/chess";
import { integrations } from "./build/integrations";
import { localWorkspace } from "./build/local-workspace";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
export default defineConfig({
  server: {
    host: "127.0.0.1",
    strictPort: true,
    ...(isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
  },
  plugins: [
    localWorkspace(),
    integrations(),
    finance(),
    health(),
    writing(),
    climbing(),
    chess(),
    vinext(),
  ],
});
