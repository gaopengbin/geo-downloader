export function keyholeViewKey(view: { longitude: number; latitude: number; zoom: number }) {
  const level = Math.min(20, Math.max(1, Math.round(view.zoom) + 1))
  const size = 2 ** level
  const cell = (degrees: number) => Math.max(0, Math.min(size - 1, Math.floor((degrees + 180) / 360 * size)))
  return `${level}/${cell(view.longitude)}/${cell(view.latitude)}`
}
