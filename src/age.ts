// The platform age range (Apple Declared Age Range, Google Play Age Signals) as the app reports it.
export type AgeSource = "apple_declared_age_range" | "google_play_age_signals";
export type AgeAvailability = "shared" | "declined" | "unavailable";

export interface AgeRange {
  availability: AgeAvailability;
  source: AgeSource;
  lowerBound: number | null;
  upperBound: number | null;
  platformStatus: string | null;
}

export const ADULT_AGE = 18;

// Who may sign in as a parent:
// - shared and the range starts at 18 or more → adult
// - shared otherwise (under 18, or not shown to be 18+) → minor, rejected
// - declined to share → rejected
// - the age API isn't offered → allowed (the 18+ declaration in the parental agreement covers it)
export type AgeDecision = "adult" | "unavailable" | "minor" | "declined";

export function decide(range: AgeRange): AgeDecision {
  if (range.availability === "declined") return "declined";
  if (range.availability === "unavailable") return "unavailable";
  return range.lowerBound !== null && range.lowerBound >= ADULT_AGE ? "adult" : "minor";
}
