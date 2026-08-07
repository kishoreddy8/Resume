import crypto from "node:crypto";
import type { SourceType } from "@/types";

export function dedupeKeyForAts(sourceType: SourceType, companyId: number, externalId: string): string {
  return `${sourceType}:${companyId}:${externalId}`;
}

export function dedupeKeyForCareerLink(companyId: number, title: string, url: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${title.trim().toLowerCase()}|${url.trim()}`)
    .digest("hex")
    .slice(0, 24);
  return `career_link:${companyId}:${hash}`;
}
