/**
 * Privacy classification for form fields. This is deliberately broad: marking
 * a field sensitive only costs its value, never its ref or its label. The two
 * source strings are embedded verbatim into the generated browser scripts so
 * node-side checks and in-page checks agree.
 */

const HINT_TERMS = [
  "pass(?:word|wd|code|phrase)?",
  "pwd",
  "secret",
  "token",
  "otp",
  "one[\\s_-]?time",
  "verification",
  "security[\\s_-]?code",
  "cvv",
  "cvc",
  "card[\\s_-]?(?:number|no)",
  "credit[\\s_-]?card",
  "debit[\\s_-]?card",
  "iban",
  "routing",
  "account[\\s_-]?(?:number|no)",
  "ssn",
  "social[\\s_-]?security",
  "national[\\s_-]?id",
  "tax[\\s_-]?id",
  "pin",
  "e-?mail",
  "phone",
  "telephone",
  "tel",
  "mobile",
  "contact",
];

const AUTOCOMPLETE_TERMS = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-(?:number|csc|exp|name|type)",
  "email",
  "tel(?:-national)?",
  "username",
  "street-address",
  "address-line[1-3]",
];

/** Matches privacy-relevant words inside a name/id/placeholder/label string. */
export const SENSITIVE_HINT_SOURCE = `(?:^|[^a-z0-9])(?:${HINT_TERMS.join("|")})`;

/** Matches privacy-relevant autocomplete tokens as whole words. */
export const SENSITIVE_AUTOCOMPLETE_SOURCE =
  `(?:^|[\\s_-])(?:${AUTOCOMPLETE_TERMS.join("|")})(?:[\\s_-]|$)`;

const HINT_PATTERN = new RegExp(SENSITIVE_HINT_SOURCE, "i");
const AUTOCOMPLETE_PATTERN = new RegExp(SENSITIVE_AUTOCOMPLETE_SOURCE, "i");

export interface SensitiveDescriptor {
  type?: string | null;
  autocomplete?: string | null;
  inputmode?: string | null;
  /** Alias used by some callers and by the DOM's inputMode property. */
  inputMode?: string | null;
  name?: string | null;
  id?: string | null;
  placeholder?: string | null;
  label?: string | null;
}

/**
 * Node-side mirror of the in-page classifier. Field types that inherently
 * carry secrets short-circuit; everything else is judged from its metadata.
 */
export function isSensitiveDescriptor(descriptor: SensitiveDescriptor): boolean {
  const type = String(descriptor.type ?? "").trim().toLowerCase();
  if (["password", "file", "email", "tel"].includes(type)) return true;

  const autocomplete = String(descriptor.autocomplete ?? "").trim().toLowerCase();
  if (autocomplete && AUTOCOMPLETE_PATTERN.test(autocomplete)) return true;

  const mode = String(descriptor.inputmode ?? descriptor.inputMode ?? "")
    .trim()
    .toLowerCase();
  if (mode === "email" || mode === "tel") return true;

  const metadata = [descriptor.name, descriptor.id, descriptor.placeholder, descriptor.label]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
  return metadata.length > 0 && HINT_PATTERN.test(metadata);
}
