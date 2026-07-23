import { RoomView } from "@/components/room/RoomView";

export const metadata = { title: "Room - WatchShare" };

export default async function RoomPage({
  params
}: {
  params: Promise<{ roomCode: string }>;
}) {
  const { roomCode } = await params;
  return <RoomView roomCode={roomCode.toUpperCase()} />;
}
