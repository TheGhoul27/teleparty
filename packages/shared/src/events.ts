import type { Ack } from "./errors";
import type { AppError } from "./errors";
import type {
  ChatMessage,
  Participant,
  RoomState,
  SharingState,
  TurnCredentials
} from "./types";
import type {
  ApproveParticipantPayload,
  AnswerPayload,
  CloseRoomPayload,
  CreateRoomPayload,
  DeleteChatMessagePayload,
  IceCandidatePayload,
  JoinRoomPayload,
  KickParticipantPayload,
  LeaveRoomPayload,
  MicrophoneStatePayload,
  OfferPayload,
  RejectParticipantPayload,
  RestartRequestPayload,
  SendChatPayload,
  SetMicPermissionPayload,
  SharingStartedPayload,
  SharingStoppedPayload
} from "./schemas";

export interface CreateRoomResult {
  roomCode: string;
  /** Returned exactly once; the server stores only a hash. */
  hostToken: string;
  reconnectToken: string;
  participantId: string;
  room: RoomState;
  iceConfig: TurnCredentials;
}

export type JoinRoomResult =
  | {
      status: "joined";
      participantId: string;
      reconnectToken: string;
      room: RoomState;
      iceConfig: TurnCredentials;
      isHost: boolean;
    }
  | {
      status: "waiting";
      participantId: string;
      reconnectToken: string;
    };

export interface SessionDescriptionMessage {
  fromParticipantId: string;
  description: { type: "offer" | "answer"; sdp: string };
}

export interface IceCandidateMessage {
  fromParticipantId: string;
  candidate: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment?: string | null;
  } | null;
}

export interface ClientToServerEvents {
  "room:create": (payload: CreateRoomPayload, callback: Ack<CreateRoomResult>) => void;
  "room:join": (payload: JoinRoomPayload, callback: Ack<JoinRoomResult>) => void;
  "room:leave": (payload: LeaveRoomPayload) => void;
  "room:approve-participant": (payload: ApproveParticipantPayload) => void;
  "room:reject-participant": (payload: RejectParticipantPayload) => void;

  "webrtc:offer": (payload: OfferPayload) => void;
  "webrtc:answer": (payload: AnswerPayload) => void;
  "webrtc:ice-candidate": (payload: IceCandidatePayload) => void;
  "webrtc:restart-request": (payload: RestartRequestPayload) => void;

  "media:sharing-started": (payload: SharingStartedPayload) => void;
  "media:sharing-stopped": (payload: SharingStoppedPayload) => void;
  "media:microphone-state": (payload: MicrophoneStatePayload) => void;

  "chat:send": (payload: SendChatPayload, callback: Ack<ChatMessage>) => void;
  "chat:delete": (payload: DeleteChatMessagePayload) => void;

  "host:kick-participant": (payload: KickParticipantPayload) => void;
  "host:close-room": (payload: CloseRoomPayload) => void;
  "host:set-mic-permission": (payload: SetMicPermissionPayload) => void;
}

export interface ServerToClientEvents {
  "room:state": (room: RoomState) => void;
  "room:participant-joined": (participant: Participant) => void;
  "room:participant-left": (payload: { participantId: string }) => void;
  "room:participant-waiting": (participant: Participant) => void;
  "room:participant-approved": (payload: { participantId: string }) => void;
  "room:participant-rejected": (payload: { participantId: string }) => void;
  "room:participant-kicked": (payload: { participantId: string }) => void;
  "room:you-were-approved": (result: Extract<JoinRoomResult, { status: "joined" }>) => void;
  "room:you-were-rejected": (error: AppError) => void;
  "room:you-were-kicked": (error: AppError) => void;
  "room:host-disconnected": (payload: { graceSeconds: number }) => void;
  "room:host-reconnected": () => void;
  "room:closed": (payload: { reason: "host-closed" | "expired" | "host-timeout" }) => void;

  "media:share-state": (sharing: SharingState) => void;
  "media:microphone-state": (payload: { participantId: string; enabled: boolean }) => void;
  "media:mic-permission": (payload: { allowed: boolean }) => void;

  "webrtc:offer": (message: SessionDescriptionMessage) => void;
  "webrtc:answer": (message: SessionDescriptionMessage) => void;
  "webrtc:ice-candidate": (message: IceCandidateMessage) => void;
  "webrtc:restart-request": (payload: { fromParticipantId: string }) => void;

  "chat:message": (message: ChatMessage) => void;
  "chat:deleted": (payload: { messageId: string }) => void;

  "system:rate-limit-warning": (payload: { message: string }) => void;
  "system:error": (error: AppError) => void;
}
