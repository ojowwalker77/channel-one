// What a relay refusal means, as a tag a client can branch on instead of
// matching message text. Plain on purpose: the web imports this, with no Effect
// runtime. The relay sends `{ error, tag }`; older relays send only `error`, so a
// missing tag falls back to one read from the status.

export const ERROR_TAGS = [
  "BadRequest",
  "SignInRequired",
  "Unauthorized",
  "NotOwner",
  "NotMember",
  "Removed",
  "Denied",
  "Forbidden",
  "ChannelGone",
  "NotFound",
  "MethodNotAllowed",
  "Conflict",
  "VaultConflict",
  "TooLarge",
  "UpdateRequired",
  "TooMany",
  "Internal",
] as const;
export type ErrorTag = (typeof ERROR_TAGS)[number];

export const isErrorTag = (x: unknown): x is ErrorTag => typeof x === "string" && (ERROR_TAGS as readonly string[]).includes(x);

/** The tag a status means when nothing more specific was said. */
export function tagForStatus(status: number): ErrorTag {
  switch (status) {
    case 400:
      return "BadRequest";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "NotFound";
    case 405:
      return "MethodNotAllowed";
    case 409:
      return "Conflict";
    case 413:
      return "TooLarge";
    case 426:
      return "UpdateRequired";
    case 429:
      return "TooMany";
    default:
      return "Internal";
  }
}
