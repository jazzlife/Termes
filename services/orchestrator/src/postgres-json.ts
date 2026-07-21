export function jsonForPostgres(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) => (
    typeof nestedValue === "string" ? nestedValue.replace(/\u0000/g, "") : nestedValue
  ));
}
