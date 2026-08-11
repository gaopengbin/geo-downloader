const REPOSITORY = "gaopengbin/geo-downloader";
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;

export type ReleaseAssetKind =
  | "windows"
  | "mac-arm64"
  | "mac-x64"
  | "linux-deb"
  | "linux-appimage";

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  download_count: number;
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

const fallbackRelease: GitHubRelease = {
  tag_name: "v3.6.7",
  name: "GeoDownloader v3.6.7",
  html_url: `${RELEASES_URL}/tag/v3.6.7`,
  published_at: "2026-08-10T15:46:55Z",
  body: "",
  draft: false,
  prerelease: false,
  assets: [
    "GeoDownloader_3.6.7_windows_x64-setup.exe",
    "GeoDownloader_3.6.7_macos_arm64.dmg",
    "GeoDownloader_3.6.7_macos_x64.dmg",
    "GeoDownloader_3.6.7_linux_amd64.deb",
    "GeoDownloader_3.6.7_linux_amd64.AppImage",
  ].map((name) => ({
    name,
    browser_download_url: `${RELEASES_URL}/download/v3.6.7/${name}`,
    size: 0,
    download_count: 0,
  })),
};

export async function getStableReleases(limit = 12): Promise<GitHubRelease[]> {
  try {
    const response = await fetch(RELEASES_API, {
      cache: "force-cache",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "GeoD-Website",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub Releases API returned ${response.status}`);
    }

    const releases = (await response.json()) as GitHubRelease[];
    const stableReleases = releases.filter(
      (release) => !release.draft && !release.prerelease,
    );

    return stableReleases.length > 0
      ? stableReleases.slice(0, limit)
      : [fallbackRelease];
  } catch {
    return [fallbackRelease];
  }
}

export function findReleaseAsset(
  release: GitHubRelease,
  kind: ReleaseAssetKind,
): GitHubReleaseAsset | undefined {
  return release.assets.find((asset) => {
    const name = asset.name.toLowerCase();

    switch (kind) {
      case "windows":
        return name.endsWith(".exe") && name.includes("windows");
      case "mac-arm64":
        return name.endsWith(".dmg") && name.includes("arm64");
      case "mac-x64":
        return name.endsWith(".dmg") && name.includes("x64");
      case "linux-deb":
        return name.endsWith(".deb");
      case "linux-appimage":
        return name.endsWith(".appimage");
    }
  });
}

export function formatAssetLabel(name: string): string {
  const normalized = name.toLowerCase();

  if (normalized.endsWith(".exe")) return "Windows x64 · EXE";
  if (normalized.includes("macos_arm64")) return "macOS · Apple Silicon";
  if (normalized.includes("macos_x64")) return "macOS · Intel x64";
  if (normalized.endsWith(".deb")) return "Linux · Debian / Ubuntu";
  if (normalized.endsWith(".appimage")) return "Linux · AppImage";
  return name;
}

export function sortReleaseAssets(
  assets: GitHubReleaseAsset[],
): GitHubReleaseAsset[] {
  const getOrder = (name: string) => {
    const normalized = name.toLowerCase();
    if (normalized.endsWith(".exe")) return 0;
    if (normalized.includes("macos_arm64")) return 1;
    if (normalized.includes("macos_x64")) return 2;
    if (normalized.endsWith(".deb")) return 3;
    if (normalized.endsWith(".appimage")) return 4;
    return 5;
  };

  return [...assets].sort((left, right) => getOrder(left.name) - getOrder(right.name));
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "安装包";
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 1 : 2)} MB`;
}
