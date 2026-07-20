export function resolveExistingSelectionId<T extends { id: string }>(
  items: T[],
  requestedId: string | null | undefined,
): string {
  if (requestedId && items.some((item) => item.id === requestedId)) {
    return requestedId;
  }
  return items[0]?.id || "";
}
