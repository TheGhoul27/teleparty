import { z } from "zod";
import { LIMITS } from "./types";

/** Trimmed, non-empty display name without control characters. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display name is required")
  .max(LIMITS.displayNameMax)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Display name contains invalid characters");

export const roomCodeSchema = z
  .string()
  .trim()
  .min(LIMITS.roomCodeMin)
  .max(LIMITS.roomCodeMax)
  .regex(/^[A-Za-z0-9]+$/, "Room codes only contain letters and numbers")
  .transform((value) => value.toUpperCase());

export const roomPasswordSchema = z.string().min(1).max(LIMITS.passwordMax);

export const createRoomPayloadSchema = z.object({
  displayName: displayNameSchema,
  settings: z
    .object({
      maxParticipants: z.number().int().min(2).max(LIMITS.maxParticipantsCeiling).optional(),
      password: roomPasswordSchema.optional(),
      waitingRoomEnabled: z.boolean().optional(),
      allowMicrophones: z.boolean().optional(),
      allowChat: z.boolean().optional(),
      ttlMinutes: z.number().int().min(5).max(24 * 60).optional()
    })
    .optional()
});

export const joinRoomPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  displayName: displayNameSchema,
  password: roomPasswordSchema.optional(),
  /** Present when re-joining after a disconnect. */
  reconnectToken: z.string().max(512).optional(),
  /** Present when the host rejoins their own room. */
  hostToken: z.string().max(512).optional()
});

export const leaveRoomPayloadSchema = z.object({
  roomCode: roomCodeSchema
});

export const approveParticipantPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  participantId: z.string().min(1).max(64)
});

export const rejectParticipantPayloadSchema = approveParticipantPayloadSchema;

export const kickParticipantPayloadSchema = approveParticipantPayloadSchema;

export const closeRoomPayloadSchema = z.object({
  roomCode: roomCodeSchema
});

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

const sdpSchema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= LIMITS.sdpMaxBytes, {
    message: "SDP payload too large"
  });

export const sessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: sdpSchema
});

export const offerPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  targetParticipantId: z.string().min(1).max(64),
  description: sessionDescriptionSchema.extend({ type: z.literal("offer") })
});

export const answerPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  targetParticipantId: z.string().min(1).max(64),
  description: sessionDescriptionSchema.extend({ type: z.literal("answer") })
});

export const iceCandidatePayloadSchema = z.object({
  roomCode: roomCodeSchema,
  targetParticipantId: z.string().min(1).max(64),
  candidate: z
    .object({
      candidate: z.string().max(LIMITS.iceCandidateMaxBytes),
      sdpMid: z.string().max(64).nullable(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable(),
      usernameFragment: z.string().max(256).nullish()
    })
    .nullable()
});

export const restartRequestPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  targetParticipantId: z.string().min(1).max(64)
});

export const sharingStartedPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  hasAudio: z.boolean(),
  surfaceIsBrowserTab: z.boolean().nullable()
});

export const sharingStoppedPayloadSchema = z.object({
  roomCode: roomCodeSchema
});

export const microphoneStatePayloadSchema = z.object({
  roomCode: roomCodeSchema,
  enabled: z.boolean()
});

export const sendChatPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  body: z.string().min(1).max(LIMITS.chatMessageMax)
});

export const deleteChatMessagePayloadSchema = z.object({
  roomCode: roomCodeSchema,
  messageId: z.string().min(1).max(64)
});

export const setMicPermissionPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  participantId: z.string().min(1).max(64),
  allowed: z.boolean()
});

export type CreateRoomPayload = z.infer<typeof createRoomPayloadSchema>;
export type JoinRoomPayload = z.infer<typeof joinRoomPayloadSchema>;
export type LeaveRoomPayload = z.infer<typeof leaveRoomPayloadSchema>;
export type ApproveParticipantPayload = z.infer<typeof approveParticipantPayloadSchema>;
export type RejectParticipantPayload = z.infer<typeof rejectParticipantPayloadSchema>;
export type KickParticipantPayload = z.infer<typeof kickParticipantPayloadSchema>;
export type CloseRoomPayload = z.infer<typeof closeRoomPayloadSchema>;
export type OfferPayload = z.infer<typeof offerPayloadSchema>;
export type AnswerPayload = z.infer<typeof answerPayloadSchema>;
export type IceCandidatePayload = z.infer<typeof iceCandidatePayloadSchema>;
export type RestartRequestPayload = z.infer<typeof restartRequestPayloadSchema>;
export type SharingStartedPayload = z.infer<typeof sharingStartedPayloadSchema>;
export type SharingStoppedPayload = z.infer<typeof sharingStoppedPayloadSchema>;
export type MicrophoneStatePayload = z.infer<typeof microphoneStatePayloadSchema>;
export type SendChatPayload = z.infer<typeof sendChatPayloadSchema>;
export type DeleteChatMessagePayload = z.infer<typeof deleteChatMessagePayloadSchema>;
export type SetMicPermissionPayload = z.infer<typeof setMicPermissionPayloadSchema>;
