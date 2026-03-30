/**
 * Clamps a numeric value to the inclusive range [min, max].
 * Returns `min` for NaN / non-finite inputs.
 */
export const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value) || Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}
