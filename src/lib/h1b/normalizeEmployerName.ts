const SUFFIXES = [
  "incorporated",
  "corporation",
  "company",
  "limited",
  "inc",
  "llc",
  "llp",
  "ltd",
  "corp",
  "co",
  "plc",
  "pllc",
];

const SUFFIX_PATTERN = new RegExp(`\\b(${SUFFIXES.join("|")})\\b\\.?`, "gi");

export function normalizeEmployerName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,'’]/g, "")
    .replace(SUFFIX_PATTERN, "")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
