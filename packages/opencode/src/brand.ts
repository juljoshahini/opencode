export const BRAND = "LanderLab"

export function applyBrand(text: string): string {
  return text.replaceAll("{{BRAND}}", BRAND)
}
