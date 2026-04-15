export function maskCustomerIdentity(
  value: string | null | undefined,
  fallback: string
) {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed.includes("@")) {
    const [localPart] = trimmed.split("@");
    const visible = localPart.slice(0, 2);
    return `${visible || "sh"}***`;
  }

  return `${trimmed.slice(0, 3) || "sho"}***`;
}
