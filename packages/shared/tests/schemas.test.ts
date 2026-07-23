import { describe, expect, it } from "vitest";
import {
  createRoomPayloadSchema,
  displayNameSchema,
  iceCandidatePayloadSchema,
  joinRoomPayloadSchema,
  offerPayloadSchema,
  roomCodeSchema,
  sendChatPayloadSchema,
  LIMITS
} from "../src/index.js";

describe("roomCodeSchema", () => {
  it("uppercases and accepts valid codes", () => {
    expect(roomCodeSchema.parse("abcd1234")).toBe("ABCD1234");
  });

  it("rejects codes with symbols", () => {
    expect(roomCodeSchema.safeParse("abc-1234").success).toBe(false);
  });

  it("rejects too-short and too-long codes", () => {
    expect(roomCodeSchema.safeParse("ab").success).toBe(false);
    expect(roomCodeSchema.safeParse("A".repeat(20)).success).toBe(false);
  });
});

describe("displayNameSchema", () => {
  it("trims whitespace", () => {
    expect(displayNameSchema.parse("  Ada  ")).toBe("Ada");
  });

  it("rejects control characters", () => {
    expect(displayNameSchema.safeParse("Ada\u0000").success).toBe(false);
  });

  it("rejects names above the limit", () => {
    expect(displayNameSchema.safeParse("x".repeat(LIMITS.displayNameMax + 1)).success).toBe(false);
  });

  it("keeps HTML as plain text (no stripping, rendering is text-only)", () => {
    const result = displayNameSchema.parse("<script>alert(1)</script>");
    expect(result).toBe("<script>alert(1)</script>");
  });
});

describe("offerPayloadSchema", () => {
  const base = {
    roomCode: "ABCD1234",
    targetParticipantId: "p_x",
    description: { type: "offer" as const, sdp: "v=0" }
  };

  it("accepts a normal offer", () => {
    expect(offerPayloadSchema.safeParse(base).success).toBe(true);
  });

  it("rejects oversized SDP", () => {
    const big = { ...base, description: { type: "offer" as const, sdp: "a".repeat(LIMITS.sdpMaxBytes + 1) } };
    expect(offerPayloadSchema.safeParse(big).success).toBe(false);
  });

  it("rejects an answer sent as offer", () => {
    const wrong = { ...base, description: { type: "answer", sdp: "v=0" } };
    expect(offerPayloadSchema.safeParse(wrong).success).toBe(false);
  });
});

describe("iceCandidatePayloadSchema", () => {
  it("accepts end-of-candidates null", () => {
    const result = iceCandidatePayloadSchema.safeParse({
      roomCode: "ABCD1234",
      targetParticipantId: "p_x",
      candidate: null
    });
    expect(result.success).toBe(true);
  });

  it("rejects oversized candidates", () => {
    const result = iceCandidatePayloadSchema.safeParse({
      roomCode: "ABCD1234",
      targetParticipantId: "p_x",
      candidate: { candidate: "c".repeat(4000), sdpMid: "0", sdpMLineIndex: 0 }
    });
    expect(result.success).toBe(false);
  });
});

describe("sendChatPayloadSchema", () => {
  it("rejects empty and oversized messages", () => {
    expect(
      sendChatPayloadSchema.safeParse({ roomCode: "ABCD1234", body: "" }).success
    ).toBe(false);
    expect(
      sendChatPayloadSchema.safeParse({
        roomCode: "ABCD1234",
        body: "x".repeat(LIMITS.chatMessageMax + 1)
      }).success
    ).toBe(false);
  });
});

describe("createRoomPayloadSchema", () => {
  it("bounds maxParticipants", () => {
    expect(
      createRoomPayloadSchema.safeParse({
        displayName: "Host",
        settings: { maxParticipants: 100 }
      }).success
    ).toBe(false);
  });
});

describe("joinRoomPayloadSchema", () => {
  it("accepts optional password and tokens", () => {
    const result = joinRoomPayloadSchema.safeParse({
      roomCode: "abcd1234",
      displayName: "Viewer",
      password: "secret",
      reconnectToken: "t"
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.roomCode).toBe("ABCD1234");
  });
});
