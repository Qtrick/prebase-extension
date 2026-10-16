/**
 * Adapted visual language from thinking-orbs (MIT © Jakub Antalik / RareFormLabs).
 * https://github.com/Qtrick/thinking-orbs-for-PreBase-
 * https://github.com/RareFormLabs/thinking-orbs
 *
 * Used only as a single shared activity indicator — not per-node canvases.
 * Plain 2D canvas arcs; respects prefers-reduced-motion.
 */

import { useEffect, useRef } from 'react';

export type OrbState = 'working' | 'searching' | 'solving';

interface ThinkingOrbProps {
  state?: OrbState;
  size?: 20 | 64;
  theme?: 'auto' | 'dark' | 'light';
  'aria-label'?: string;
  className?: string;
  paused?: boolean;
}

function inkForTheme(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? 'rgba(248,250,252,0.92)' : 'rgba(15,23,42,0.88)';
}

function resolveTheme(theme: 'auto' | 'dark' | 'light'): 'dark' | 'light' {
  if (theme === 'dark' || theme === 'light') return theme;
  const body = document.body;
  const kind = body.getAttribute('data-vscode-theme-kind') ?? '';
  if (kind.includes('light')) return 'light';
  if (window.matchMedia?.('(prefers-color-scheme: light)')?.matches) return 'light';
  return 'dark';
}

export function ThinkingOrb({
  state = 'working',
  size = 64,
  theme = 'auto',
  'aria-label': ariaLabel,
  className,
  paused = false,
}: ThinkingOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const reduceMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    const dotCount = size === 64 ? 18 : 10;
    const radius = size * 0.34;
    let frame = 0;
    let raf = 0;
    let alive = true;

    const draw = (t: number) => {
      if (!alive) return;
      const resolved = resolveTheme(theme);
      const ink = inkForTheme(resolved);
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      const cy = size / 2;
      const phase = reduceMotion || paused ? 0 : t / 900;

      for (let i = 0; i < dotCount; i++) {
        const a = (i / dotCount) * Math.PI * 2 + phase * (state === 'searching' ? 1.4 : 0.9);
        const wobble =
          reduceMotion || paused
            ? 0
            : Math.sin(phase * 2 + i) * (size === 64 ? 2.2 : 1.1);
        const x = cx + Math.cos(a) * (radius + wobble);
        const y = cy + Math.sin(a) * (radius + wobble * 0.7);
        const r = size === 64 ? 2.1 : 1.2;
        ctx.beginPath();
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.35 + (i % 3) * 0.2;
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1;
      ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (!reduceMotion && !paused) {
        frame += 1;
        raf = requestAnimationFrame(draw);
      }
    };

    draw(0);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [paused, size, state, theme]);

  const label =
    ariaLabel ??
    (state === 'searching'
      ? 'Searching repository structure'
      : state === 'solving'
        ? 'Resolving graph relationships'
        : 'Analyzing codebase');

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={label}
      width={size}
      height={size}
    />
  );
}
