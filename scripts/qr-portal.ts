import { startQrPortal } from "../src/voice-room/qr-portal.js";

async function main() {
  const accessToken = process.env.QR_PORTAL_TOKEN?.trim() ?? "";
  const publicBaseUrl = process.env.QR_PORTAL_PUBLIC_URL?.trim() ?? "";
  const rawPort = process.env.QR_PORTAL_PORT?.trim();
  const port = rawPort ? Number(rawPort) : 3012;
  if (!accessToken || !publicBaseUrl || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("qr-portal-config-invalid");
  }
  const portal = await startQrPortal({
    port,
    host: "127.0.0.1",
    accessToken,
    publicBaseUrl,
    pushPlusToken: process.env.PUSHPLUS_TOKEN?.trim() || undefined,
    serverChanKey: process.env.SERVERCHAN_KEY?.trim() || undefined,
  });
  console.log(`QR portal listening on ${portal.url}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void portal.close().finally(() => {
      console.log("QR portal stopped.");
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "qr-portal-failed");
  process.exitCode = 1;
});
