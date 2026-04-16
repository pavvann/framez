"use client";

import { useRef, useCallback } from "react";

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  decimals?: number;
  onChange: (value: number) => void;
}

export default function Knob({ label, value, min, max, decimals = 2, onChange }: KnobProps) {
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);

  // map value → rotation angle (-135° to +135°)
  const t = (value - min) / (max - min);
  const angle = -135 + t * 270;

  // indicator dot position on the knob face
  const r = 22;
  const rad = (angle - 90) * (Math.PI / 180);
  const dotX = 36 + r * Math.cos(rad);
  const dotY = 36 + r * Math.sin(rad);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    startValue.current = value;
    e.preventDefault();

    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dy = startY.current - e.clientY; // up = increase
      const sensitivity = (max - min) / 180;
      const next = Math.min(max, Math.max(min, startValue.current + dy * sensitivity));
      onChange(next);
    };

    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [value, min, max, onChange]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const sensitivity = (max - min) / 100;
    const next = Math.min(max, Math.max(min, value - e.deltaY * sensitivity));
    onChange(next);
  }, [value, min, max, onChange]);

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <span className="font-mono text-white/40 text-[10px] tracking-widest uppercase">
        {value.toFixed(decimals)}
      </span>

      <svg
        width="72"
        height="72"
        viewBox="0 0 72 72"
        onMouseDown={onMouseDown}
        onWheel={onWheel}
        className="cursor-ns-resize"
      >
        {/* outer ring */}
        <circle cx="36" cy="36" r="34" fill="#0a0a0a" stroke="#2a2a2a" strokeWidth="1.5" />

        {/* track arc — 270° from bottom-left to bottom-right */}
        <circle
          cx="36" cy="36" r="26"
          fill="none"
          stroke="#1a1a1a"
          strokeWidth="4"
          strokeDasharray={`${270 / 360 * 2 * Math.PI * 26} ${360 / 360 * 2 * Math.PI * 26}`}
          strokeDashoffset={`${(90 - 135) / 360 * 2 * Math.PI * 26 * -1}`}
          strokeLinecap="round"
          transform="rotate(135 36 36)"
        />

        {/* active arc */}
        {t > 0 && (
          <circle
            cx="36" cy="36" r="26"
            fill="none"
            stroke="#e0e0e0"
            strokeWidth="4"
            strokeDasharray={`${t * 270 / 360 * 2 * Math.PI * 26} ${2 * Math.PI * 26}`}
            strokeLinecap="round"
            transform="rotate(135 36 36)"
          />
        )}

        {/* inner knob face */}
        <circle cx="36" cy="36" r="20" fill="#111" stroke="#222" strokeWidth="1" />

        {/* indicator dot */}
        <circle cx={dotX} cy={dotY} r="3" fill="white" />
      </svg>

      <span className="font-mono text-white/50 text-[9px] tracking-[0.2em] uppercase">
        {label}
      </span>
    </div>
  );
}
