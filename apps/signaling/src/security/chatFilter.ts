/**
 * Basic abuse filtering for chat. Deliberately conservative: masks a small
 * list of slurs/abusive terms and collapses excessive repetition. Messages
 * are always treated as plain text by clients, so no HTML handling here.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /\bn[i1]gg+[ae]r?s?\b/gi,
  /\bf[a@]gg?[o0]ts?\b/gi,
  /\bk[i1]kes?\b/gi,
  /\bc[o0][o0]ns?\b/gi,
  /\btr[a@]nn(y|ies)\b/gi
];

export function filterChatBody(body: string): string {
  let out = body;
  for (const pattern of BLOCKED_PATTERNS) {
    out = out.replace(pattern, (match) => "*".repeat(match.length));
  }
  // Collapse runs of the same character beyond 12 repeats (zalgo/spam).
  out = out.replace(/(.)\1{12,}/g, (_m, ch: string) => ch.repeat(12));
  return out;
}

/** Strips characters that break rendering; chat stays plain text. */
export function normalizeChatBody(body: string): string {
  // eslint-disable-next-line no-control-regex
  return body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}
