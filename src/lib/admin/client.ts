/** Add the explicit owner context required by every global Admin HTTP route. */
export function adminApiUrl(path: string, candidateId: number): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}candidateId=${encodeURIComponent(String(candidateId))}`;
}
