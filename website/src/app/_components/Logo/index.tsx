const Logo = ({
  className,
  height = 25,
  width,
  loading,
  ...rest
}: React.HTMLProps<HTMLDivElement> & {
  height?: number;
  width?: string | number;
  loading?: "eager" | "lazy";
}) => {
  const fixedHeight = Math.round(Number(height) || 25);

  return (
    <div
      {...rest}
      className="flex items-center gap-2 font-semibold tracking-wide text-white"
      style={{
        width,
        height: height ? `${height}px` : undefined,
      }}
    >
      <span
        className="inline-flex items-center justify-center rounded-lg bg-blue-500/85 text-white"
        style={{
          width: Math.max(fixedHeight * 0.9, 24),
          minWidth: 24,
          height: Math.max(fixedHeight * 0.9, 24),
          fontSize: Math.max(Math.round(fixedHeight * 0.44), 12),
        }}
      >
        G
      </span>
      <span className="text-lg">GeoD</span>
    </div>
  );
};

export default Logo;
