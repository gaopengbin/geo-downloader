import { Compass, Globe2, MountainSnow, Orbit, ScanLine, Waves, type LucideIcon } from "lucide-react";

export const avatarPresets: { id: string; name: string; colors: [string, string]; icon: LucideIcon }[] = [
  { id: "summit", name: "山峰", colors: ["#2563eb", "#7dd3fc"], icon: MountainSnow },
  { id: "orbit", name: "轨道", colors: ["#4938ba", "#a78bfa"], icon: Orbit },
  { id: "globe", name: "地球", colors: ["#087e8b", "#64d8cb"], icon: Globe2 },
  { id: "coast", name: "海岸", colors: ["#0071a6", "#5bd4ed"], icon: Waves },
  { id: "terrain", name: "地形", colors: ["#198263", "#9ad49c"], icon: ScanLine },
  { id: "compass", name: "罗盘", colors: ["#b65342", "#f4b26e"], icon: Compass },
];

export function defaultAvatarPreset(userId: string) {
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return avatarPresets[hash % avatarPresets.length];
}
