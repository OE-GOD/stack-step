/**
 * The limits of one request to the tutor function.
 *
 * The function checks the same numbers again (TUTOR_LIMITS in server/tutorCore.ts) and
 * rejects a request that breaks one. The browser code cannot import from server/, so the
 * numbers are written twice; a test in server/tutorCore.test.ts compares the two lists.
 */
export const TUTOR_CLIENT_LIMITS = {
  /** How many of the newest messages are sent. (The function accepts no more.) */
  maxMessages: 12,
  /** Characters in one message: a question, or an earlier reply. */
  maxMessageChars: 2000,
  maxCodeChars: 12_000,
  maxMachineChars: 6000,
  maxProblemChars: 3000,
  /** The whole request, in bytes (64 kB). */
  maxBodyBytes: 64_000,
} as const
