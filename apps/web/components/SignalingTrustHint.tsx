"use client";

import { useEffect, useState } from "react";
import { getSignalingUrl } from "@/services/signalingClient";

const STUCK_AFTER_MS = 5000;

/**
 * Shown when the signaling connection stays down for a while. The most common
 * cause on LAN/VPN setups is the self-signed dev certificate: browsers refuse
 * WebSockets to a not-yet-trusted certificate without showing any prompt, so
 * without this hint the app just spins forever. Directing the user to the
 * /health endpoint lets them accept the certificate, after which the socket
 * connects normally.
 */
export function SignalingTrustHint({
  status
}: {
  status: "connecting" | "connected" | "disconnected";
}) {
  const [stuck, setStuck] = useState(false);
  const [healthUrl, setHealthUrl] = useState<string | null>(null);

  useEffect(() => {
    if (status === "connected") {
      setStuck(false);
      return;
    }
    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // getSignalingUrl reads window.location, so resolve it client-side only.
  useEffect(() => {
    const url = getSignalingUrl();
    const selfSignedLikely = url.startsWith("https://") && !url.includes("//localhost");
    setHealthUrl(selfSignedLikely ? `${url}/health` : null);
  }, []);

  if (!stuck || status === "connected" || !healthUrl) return null;

  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-700/50 bg-amber-950/40 p-3 text-sm text-amber-200"
    >
      <p className="mb-2 font-medium">Still can&rsquo;t reach the room server.</p>
      <p>
        If this server uses a self-signed certificate (local development), your browser is
        silently blocking the connection. Open{" "}
        <a
          href={healthUrl}
          target="_blank"
          rel="noreferrer"
          className="font-mono underline underline-offset-4"
        >
          {healthUrl}
        </a>{" "}
        in a new tab, accept the security warning, then reload this page.
      </p>
    </div>
  );
}
