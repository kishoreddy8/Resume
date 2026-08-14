export type JobLocationScope = "US" | "NON_US" | "UNKNOWN";

// Keep this classifier conservative: a false US classification loads an out-of-scope job, while
// UNKNOWN can be revisited with richer provider detail. Two-letter state codes are accepted only
// in address-like contexts (for example "Austin, TX"), never as arbitrary words such as "IN".
const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas",
  "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
  "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia",
] as const;

const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
  "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
] as const;

const NON_US_COUNTRIES = [
  "canada", "mexico", "united kingdom", "england", "scotland", "wales", "ireland", "france",
  "germany", "spain", "italy", "netherlands", "belgium", "switzerland", "austria", "poland",
  "portugal", "sweden", "norway", "denmark", "finland", "czech republic", "czechia", "romania",
  "hungary", "ukraine", "israel", "india", "pakistan", "bangladesh", "sri lanka", "singapore",
  "china", "japan", "south korea", "korea", "taiwan", "hong kong", "philippines", "malaysia",
  "indonesia", "thailand", "vietnam", "australia", "new zealand", "brazil", "argentina", "chile",
  "colombia", "peru", "costa rica", "south africa", "nigeria", "kenya", "egypt", "turkey",
  "united arab emirates", "saudi arabia",
] as const;

function phraseRegex(phrases: readonly string[]): RegExp {
  const escaped = phrases.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:^|[^a-z])(?:${escaped.join("|")})(?:$|[^a-z])`, "i");
}

const US_STATE_NAME_RE = phraseRegex(US_STATE_NAMES);
const NON_US_COUNTRY_RE = phraseRegex(NON_US_COUNTRIES);
const US_STATE_CODE_RE = new RegExp(`(?:,|\\(|\\-|/)\\s*(?:${US_STATE_CODES.join("|")})(?:\\s|,|\\)|/|$)`);
// ADP and some other feeds render Canadian addresses as "Toronto, ON, CA". In that shape the
// final CA is the ISO country code, not California. Recognize the province + country suffix before
// applying the U.S. state-code rule.
const CANADIAN_PROVINCE_COUNTRY_RE = /(?:,|\()\s*(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\s*,\s*CA(?:\s|\)|$)/i;

// Indian state/territory abbreviations (ISO 3166-2:IN) followed by the ISO country code IN or IND.
// Matches shapes like "Bangalore, KA, IN", "Chennai, TN, IN", "Hyderabad, TS, IN".
// Evaluated before U.S. state codes so country-level evidence outranks state-abbreviation matching.
const INDIAN_STATE_COUNTRY_RE = /(?:,|\()\s*(?:AN|AP|AR|AS|BR|CG|CH|DD|DL|GA|GJ|HP|HR|JH|JK|KA|KL|LA|LD|MH|ML|MN|MP|MZ|NL|OD|PB|PY|RJ|SK|TN|TR|TS|UK|UP|WB)\s*,\s*(?:IN|IND)(?:\s|,|\)|\/|$)/i;

// Full Indian state/territory names directly preceding the ISO country code IN, IND, or country name India.
// Without this, a shape like "Bengaluru, Karnataka, IN" or bare "Karnataka, IN" falls through every other
// check and gets caught by the U.S. state-code rule below (the trailing ", IN" reads as Indiana),
// silently misclassifying a real Indian posting as a U.S. one.
const INDIAN_STATE_NAMES = [
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat",
  "haryana", "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh",
  "maharashtra", "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "orissa", "punjab",
  "rajasthan", "sikkim", "tamil nadu", "telangana", "tripura", "uttar pradesh",
  "uttarakhand", "uttaranchal", "west bengal", "jammu and kashmir", "puducherry", "pondicherry",
  "chandigarh", "ladakh",
] as const;
const INDIAN_STATE_NAME_RE = new RegExp(
  `(?:^|[^a-z])(?:${INDIAN_STATE_NAMES.join("|")})\\s*,\\s*(?:IN|IND|India)(?:\\s|,|\\)|\\/|$)`,
  "i"
);

// Known non-U.S. cities that appear in feeds with the ambiguous ", IN" or ", IND" suffix (India).
// Guards against "Bangalore, IN", "Chennai, IN" being classified as Indiana.
const INDIAN_CITY_NAMES = [
  "bangalore", "bengaluru", "chennai", "madras", "hyderabad", "secunderabad", "mumbai", "bombay",
  "pune", "delhi", "new delhi", "noida", "greater noida", "gurugram", "gurgaon", "kolkata",
  "calcutta", "indore", "jaipur", "ahmedabad", "kochi", "cochin", "ernakulam", "coimbatore",
  "chandigarh", "mohali", "panchkula", "raipur", "lucknow", "thiruvananthapuram", "trivandrum",
  "bhubaneswar", "nagpur", "visakhapatnam", "vizag", "mysore", "mysuru", "mangalore", "mangaluru",
  "vadodara", "baroda", "surat", "nashik", "bhopal", "patna", "ranchi", "guwahati", "dehradun",
] as const;
const INDIAN_CITY_RE = new RegExp(
  `(?:^|[^a-z])(?:${INDIAN_CITY_NAMES.join("|")})\\s*(?:,|\\/|\\s*-\\s*)\\s*(?:IN|IND|india)(?:\\s|,|\\)|\\/$|$)`,
  "i"
);

// Known non-U.S. cities with slash-separated locations (e.g. "Indore/Gurugram, IN").
const INDIAN_SLASH_CITY_RE = new RegExp(
  `(?:${INDIAN_CITY_NAMES.join("|")})\\s*(?:\\/[^,]+)?\\s*,\\s*(?:IN|IND|india)(?:\\s|,|\\)|$)`,
  "i"
);

/** Classifies only explicit evidence. Bare "Remote", blank strings, regions, and ambiguous city
 * names remain UNKNOWN. A multi-location value is US when any location explicitly includes the US. */
export function classifyJobLocation(location: string | null | undefined): JobLocationScope {
  const value = location?.trim();
  if (!value) return "UNKNOWN";

  // 1. Explicit U.S. country evidence — highest priority
  if (/\b(?:united states(?: of america)?|u\.?s\.?(?:a\.?)?|usa)\b/i.test(value)) return "US";
  if (/\b(?:remote|anywhere)\s*[-–—,(]?\s*(?:us|u\.s\.|usa|united states)\b/i.test(value)) return "US";

  // 2. Non-U.S. country-level evidence — outranks state abbreviation matching
  if (CANADIAN_PROVINCE_COUNTRY_RE.test(value)) return "NON_US";
  if (INDIAN_STATE_COUNTRY_RE.test(value)) return "NON_US";
  if (INDIAN_STATE_NAME_RE.test(value)) return "NON_US";
  if (INDIAN_CITY_RE.test(value)) return "NON_US";
  if (INDIAN_SLASH_CITY_RE.test(value)) return "NON_US";

  // 3. U.S. state codes/names — only after country-level evidence is exhausted
  if (US_STATE_CODE_RE.test(value) || US_STATE_NAME_RE.test(value)) return "US";

  if (/(?:^|[^a-z])u\.?k\.?(?:$|[^a-z])/i.test(value)) return "NON_US";
  if (NON_US_COUNTRY_RE.test(value)) return "NON_US";
  return "UNKNOWN";
}
