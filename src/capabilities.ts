export interface CapabilityOption {
  id: string;
  label: string;
  selected: boolean;
}

// Material icon names leak into innerText as snake_case words (arrow_drop_down, crop_16_9, volume_up).
const ICON_WORDS = /\b(?:volume_up|[a-z]+(?:_[a-z0-9]+)+)\b/g;

export function cleanCapabilityLabel(value: string): string {
  return value
    .replace(ICON_WORDS, " ")
    .replace(/[🍌]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCapabilityId(value: string): string {
  return cleanCapabilityLabel(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^gemini\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseOutputCount(value: string): number | undefined {
  const match = cleanCapabilityLabel(value).match(/^(?:x\s*)?(\d+)(?:\s*x)?$/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

export function parseDurationSeconds(value: string): number | undefined {
  const match = value.match(/\b(4|6|8|10)\s*(?:s|sec|seconds?|seg|segundos?)\b/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}
