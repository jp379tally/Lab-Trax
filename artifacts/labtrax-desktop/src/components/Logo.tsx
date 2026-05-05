interface LogoProps {
  size?: number;
  showWordmark?: boolean;
  variant?: "light" | "dark";
}

export function Logo({ size = 32, showWordmark = true, variant = "light" }: LogoProps) {
  const wordmarkColor = variant === "light" ? "text-foreground" : "text-white";
  return (
    <div className="flex items-center gap-2.5">
      <img
        src={`${import.meta.env.BASE_URL}brand/labtrax-icon.png`}
        alt="LabTrax"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="rounded-md object-contain"
      />
      {showWordmark && (
        <div className="flex flex-col leading-none">
          <span className={`font-bold tracking-tight ${wordmarkColor}`} style={{ fontSize: size * 0.55 }}>
            LabTrax
          </span>
          <span
            className={`text-[10px] uppercase tracking-[0.18em] ${
              variant === "light" ? "text-muted-foreground" : "text-white/60"
            }`}
          >
            Lab Operations
          </span>
        </div>
      )}
    </div>
  );
}
