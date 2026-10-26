// The platform age range (Apple Declared Age Range, Google Play Age Signals) as the app reports it.
export type AgeSource = "apple_declared_age_range" | "google_play_age_signals";
export type AgeCategory = "adult" | "minor" | "unknown";

export interface AgeRange {
  source: AgeSource;
  lowerBound: number | null;
  upperBound: number | null;
  platformStatus: string | null;
}

export const ADULT_AGE = 18;

// Upper bound under 18 → minor; lower bound 18 or more → adult; anything else (declined, not available) → unknown.
export function classify(range: AgeRange): AgeCategory {
  if (range.upperBound !== null && range.upperBound < ADULT_AGE) return "minor";
  if (range.lowerBound !== null && range.lowerBound >= ADULT_AGE) return "adult";
  return "unknown";
}
