"use client";

import { useEffect, useState } from "react";
import type { GeoDAccount } from "@/lib/account";
import { avatarPresets, defaultAvatarPreset } from "@/lib/avatars";

type User = NonNullable<GeoDAccount["user"]>;

export function PresetAvatar({ id, size, className }: { id: string; size: number; className?: string }) {
  const preset = avatarPresets.find(item => item.id === id) ?? avatarPresets[0];
  const Icon = preset.icon;
  return <span className={className} style={{ display: "grid", placeItems: "center", flex: "none", width: size, height: size, borderRadius: "50%", overflow: "hidden", background: `linear-gradient(145deg, ${preset.colors[0]}, ${preset.colors[1]})`, color: "#fff" }} aria-hidden="true">
    <Icon size={Math.round(size * .49)} strokeWidth={1.8} />
  </span>;
}

export default function Avatar({ user, size, className }: { user: User; size: number; className?: string }) {
  const uploaded = user.avatar?.kind === "upload" ? `/api/account/avatar?v=${encodeURIComponent(user.avatar.version)}` : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  useEffect(() => setFailedSource(null), [uploaded]);
  if (uploaded && failedSource !== uploaded) return <img className={className} src={uploaded} alt="" width={size} height={size} draggable={false} onError={() => setFailedSource(uploaded)} style={{ display: "block", flex: "none", width: size, height: size, borderRadius: "50%", objectFit: "cover" }} />;
  const presetId = user.avatar?.kind === "preset" ? user.avatar.id : defaultAvatarPreset(user.id).id;
  return <PresetAvatar id={presetId} size={size} className={className} />;
}
