import type { Severity, Verdict } from "@/lib/domain/types";

/** The Plimsoll mark: a ring crossed by the load line. */
export function PlimsollMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M2.5 16h27" stroke="var(--red)" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <PlimsollMark size={26} />
      <span className="font-display text-[1.55rem] leading-none tracking-tight">Plimsoll</span>
    </span>
  );
}

/**
 * Severity as maritime signal flags: Bravo (red swallowtail — "dangerous
 * cargo") for blockers, a yellow square for warnings, a blue pennant for
 * advisories.
 */
export function SignalFlag({ severity, size = 18 }: { severity: Severity; size?: number }) {
  const label = severity === "blocker" ? "Blocker" : severity === "warning" ? "Warning" : "Advisory";
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" role="img" aria-label={label} className="shrink-0">
      <path d="M3 2v17" stroke="var(--ink-2)" strokeWidth="1.6" strokeLinecap="round" />
      {severity === "blocker" && <path d="M4 3h13l-4 4.5 4 4.5H4z" fill="var(--red)" />}
      {severity === "warning" && <rect x="4" y="3" width="12" height="9" rx="0.5" fill="var(--amber)" />}
      {severity === "advisory" && <path d="M4 3l13 4.5L4 12z" fill="var(--blue)" />}
    </svg>
  );
}

export const VERDICT_COPY: Record<Verdict, { stamp: string; color: string; soft: string; line: string }> = {
  cleared: { stamp: "Cleared to sail", color: "var(--sea)", soft: "var(--sea-soft)", line: "Every document agrees. Safe to file." },
  review: { stamp: "Review first", color: "var(--amber)", soft: "var(--amber-soft)", line: "No blockers, but warnings worth fixing." },
  hold: { stamp: "Hold · do not file", color: "var(--red)", soft: "var(--red-soft)", line: "Blockers would cause a hold or rejection." },
};

export function VerdictStamp({ verdict, size = "md", animate = false }: { verdict: Verdict; size?: "sm" | "md" | "lg"; animate?: boolean }) {
  const v = VERDICT_COPY[verdict];
  const cls = size === "lg" ? "text-base px-3 py-1" : size === "sm" ? "text-[0.62rem]" : "text-xs";
  return (
    <span className={`stamp ${cls} ${animate ? "stamp-in" : ""}`} style={{ color: v.color }}>
      {v.stamp}
    </span>
  );
}

/**
 * The load-line gauge. The hull carries a Plimsoll mark; the sea rises with
 * the pack's risk. Above the mark, the pack is overloaded — hold it. The
 * band each verdict occupies is fixed so the picture never contradicts the
 * verdict, and the score positions the water inside the band.
 */
export function LoadLineGauge({ score, verdict, compact = false, uid = "g" }: { score: number; verdict: Verdict; compact?: boolean; uid?: string }) {
  const W = 220;
  const H = 150;
  const hullTop = 26;
  const hullBottom = 138;
  const hullH = hullBottom - hullTop;
  const markY = hullTop + hullH * 0.42; // the load line
  const s = Math.max(0, Math.min(100, score)) / 100;
  // Fraction of the hull that is submerged.
  const band = verdict === "cleared" ? [0.18, 0.4] : verdict === "review" ? [0.42, 0.56] : [0.62, 0.9];
  const submerged = band[1] - (band[1] - band[0]) * s;
  const waterY = hullBottom - hullH * submerged;
  const color = VERDICT_COPY[verdict].color;
  const wave = (y: number) =>
    `M-40 ${y} q 15 -5 30 0 t 30 0 t 30 0 t 30 0 t 30 0 t 30 0 t 30 0 t 30 0 t 30 0 t 30 0 V ${H + 10} H -40 Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={compact ? "w-full max-w-[180px]" : "w-full"} role="img" aria-label={`Readiness ${score} out of 100`}>
      <defs>
        <clipPath id={`hull-${uid}`}>
          <path d={`M30 ${hullTop} H190 L176 ${hullBottom} Q110 ${hullBottom + 8} 44 ${hullBottom} Z`} />
        </clipPath>
        <linearGradient id={`sea-${uid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--water)" stopOpacity="0.85" />
          <stop offset="1" stopColor="var(--water)" stopOpacity="1" />
        </linearGradient>
      </defs>
      {/* Hull */}
      <path d={`M30 ${hullTop} H190 L176 ${hullBottom} Q110 ${hullBottom + 8} 44 ${hullBottom} Z`} fill="var(--card)" stroke="var(--hull)" strokeWidth="2" />
      <path d={`M30 ${hullTop} H190`} stroke="var(--hull)" strokeWidth="4" />
      {/* Plimsoll mark painted on the hull */}
      <g stroke="var(--hull)" strokeWidth="2.2" fill="none">
        <circle cx="96" cy={markY} r="13" />
        <path d={`M74 ${markY} H118`} />
        <path d={`M134 ${markY - 22} V${markY + 14}`} />
        <path d={`M134 ${markY - 22} H152 M134 ${markY - 10} H148 M134 ${markY} H152 M134 ${markY + 10} H148`} />
      </g>
      <text x="80" y={markY - 17} fontSize="8" fill="var(--hull)" fontFamily="var(--font-mono)">L</text>
      <text x="107" y={markY - 17} fontSize="8" fill="var(--hull)" fontFamily="var(--font-mono)">R</text>
      {/* Sea */}
      <g className="swell">
        <path d={wave(waterY)} fill={`url(#sea-${uid})`} opacity="0.92" style={{ transition: "d 0.9s ease" }} />
      </g>
      <g clipPath={`url(#hull-${uid})`} className="swell">
        <path d={wave(waterY)} fill={color} opacity="0.22" />
      </g>
      <path d={`M0 ${waterY} H${W}`} stroke={color} strokeWidth="1" strokeDasharray="3 4" opacity="0.8" />
    </svg>
  );
}
