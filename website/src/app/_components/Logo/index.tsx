import Image from "next/image";

// Crop only the displayed region of the supplied white-background PNG.
// The source artwork remains unchanged in the GeoD-logo asset pack.
const artwork = { width: 2172, height: 724, left: 396, top: 142, right: 1776, bottom: 582 };

const Logo = ({
  className,
  height = 36,
  width,
  loading = "eager",
  ...rest
}: React.HTMLProps<HTMLDivElement> & {
  height?: number;
  width?: string | number;
  loading?: "eager" | "lazy";
}) => {
  const visibleHeight = Math.max(Math.round(Number(height) || 36), 1);
  const scale = visibleHeight / (artwork.bottom - artwork.top);

  return (
    <div
      {...rest}
      className={className}
      style={{
        display: "block",
        position: "relative",
        flex: "none",
        overflow: "hidden",
        width: width ?? Math.round((artwork.right - artwork.left) * scale),
        height: visibleHeight,
      }}
    >
      <Image
        src="/geod-site/logo-horizontal.png"
        alt="GeoD"
        width={artwork.width}
        height={artwork.height}
        loading={loading}
        unoptimized
        style={{
          position: "absolute",
          maxWidth: "none",
          width: artwork.width * scale,
          height: artwork.height * scale,
          left: -artwork.left * scale,
          top: -artwork.top * scale,
          mixBlendMode: "multiply",
        }}
      />
    </div>
  );
};

export default Logo;
