import Link from "next/link";

export const metadata = { title: "Unsupported browser - WatchShare" };

export default function UnsupportedPage() {
  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-3xl font-bold text-white">This browser is not supported</h1>
      <p className="text-gray-300">
        WatchShare needs WebRTC (<code>RTCPeerConnection</code>) to receive a stream, and screen
        capture (<code>getDisplayMedia</code>) to host one. Your current browser does not provide
        the required APIs.
      </p>
      <ul className="list-disc space-y-2 pl-6 text-gray-300">
        <li>To watch a room, use any current version of Chrome, Edge, Firefox, or Safari.</li>
        <li>
          To host with tab audio, use a Chromium-based desktop browser (Chrome or Edge on Windows
          or macOS) and enable &ldquo;Share tab audio&rdquo; in the sharing dialog.
        </li>
        <li>Mobile browsers can usually watch, but cannot host a tab share.</li>
      </ul>
      <Link href="/" className="text-accent-300 underline underline-offset-4">
        Back to the home page
      </Link>
    </main>
  );
}
