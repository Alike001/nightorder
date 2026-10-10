import { z } from "zod";

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/;

function hasNonZeroDigit(value: string): boolean {
  return /[1-9]/.test(value);
}

function isRealUtcTimestamp(value: string): boolean {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) return false;

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return false;

  const [datePart] = value.split("T");
  return date.toISOString().slice(0, 10) === datePart;
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** A canonical, non-negative base-10 decimal without signs or exponent notation. */
export const nonNegativeDecimalSchema = z
  .string()
  .regex(DECIMAL_PATTERN, "Must be a canonical non-negative decimal string");

/** A canonical base-10 decimal strictly greater than zero. */
export const positiveDecimalSchema = nonNegativeDecimalSchema.refine(
  hasNonZeroDigit,
  "Must be greater than zero",
);

/** An ISO-8601 timestamp expressed explicitly in UTC with a trailing `Z`. */
export const utcTimestampSchema = z
  .string()
  .refine(isRealUtcTimestamp, "Must be a valid UTC ISO-8601 timestamp ending in Z");

/** An IANA named timezone, such as `Africa/Lagos`; `UTC` is also accepted. */
export const ianaTimezoneSchema = z
  .string()
  .min(1)
  .refine(isIanaTimezone, "Must be a valid IANA timezone name");

export const stableIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim(), "Must not contain surrounding whitespace");
export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, "Must be a lowercase SHA-256 digest");

/** Compare canonical decimal strings without converting them to binary floating point. */
export function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 {
  const parsedLeft = nonNegativeDecimalSchema.parse(left);
  const parsedRight = nonNegativeDecimalSchema.parse(right);
  const [leftWhole = "", leftFraction = ""] = parsedLeft.split(".");
  const [rightWhole = "", rightFraction = ""] = parsedRight.split(".");

  if (leftWhole.length !== rightWhole.length) return leftWhole.length < rightWhole.length ? -1 : 1;
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;

  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(fractionLength, "0");
  const normalizedRight = rightFraction.padEnd(fractionLength, "0");
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

/** Compare validated UTC timestamps, including arbitrary-length fractional seconds. */
export function compareUtcTimestamps(left: string, right: string): -1 | 0 | 1 {
  const parsedLeft = utcTimestampSchema.parse(left);
  const parsedRight = utcTimestampSchema.parse(right);
  const leftSecond = parsedLeft.slice(0, 19);
  const rightSecond = parsedRight.slice(0, 19);

  if (leftSecond !== rightSecond) {
    return new Date(`${leftSecond}Z`).valueOf() < new Date(`${rightSecond}Z`).valueOf() ? -1 : 1;
  }

  const leftFraction = parsedLeft.slice(19, -1).replace(/^\./, "");
  const rightFraction = parsedRight.slice(19, -1).replace(/^\./, "");
  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(fractionLength, "0");
  const normalizedRight = rightFraction.padEnd(fractionLength, "0");
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

export type NonNegativeDecimal = z.infer<typeof nonNegativeDecimalSchema>;
export type PositiveDecimal = z.infer<typeof positiveDecimalSchema>;
export type UtcTimestamp = z.infer<typeof utcTimestampSchema>;
export type IanaTimezone = z.infer<typeof ianaTimezoneSchema>;
