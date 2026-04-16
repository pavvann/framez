"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Knob from "@/components/Knob";

const CHARS = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const FONT_SIZE = 14;
const FLEE_FORCE = 8;
const DAMPING = 0.84;
const RETURN_FORCE = 0.04;

const WAVE_SPEED = 0.00022;
const WAVE_FREQ_X = 0.045;
const WAVE_FREQ_Y = 0.06;
const WAVE_AMP_X = 6;
const WAVE_AMP_Y = 5;
const WAVE_SECONDARY_SPEED = 0.00015;
const WAVE_SECONDARY_FREQ = 0.03;
const WAVE_SECONDARY_AMP = 4;


const KONAMI = [
  "ArrowUp","ArrowUp","ArrowDown","ArrowDown",
  "ArrowLeft","ArrowRight","ArrowLeft","ArrowRight",
  "b","a",
];

interface Particle {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  char: string;
  charTimer: number;
  charInterval: number;
  panicRadius: number;
  fleeAngleJitter: number;
}

function randomChar() {
  return CHARS[Math.floor(Math.random() * CHARS.length)];
}

export default function AsciiCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: -9999, y: -9999 });
  const particles = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);
  const timeRef = useRef<number>(0);

  // audio
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const freqDataRef = useRef<Uint8Array | null>(null);
  const timeDomainRef = useRef<Uint8Array | null>(null);
  const bassRef = useRef(0);

  // beat detection
  const kickFlashRef = useRef(0);
  const workletRef = useRef<AudioWorkletNode | null>(null);

  const [fluxThreshold, setFluxThreshold] = useState(0.05);
  const [rmsMultiplier, setRmsMultiplier] = useState(1.5);

  // visualizer
  const smoothedSpecRef = useRef<Float32Array | null>(null);
  const pendingKickRef = useRef(false);

  const [playing, setPlaying] = useState(false);

  // easter egg state
  const konamiProgress = useRef(0);
  const typedBuffer = useRef("");
  const matrixMode = useRef(0);
  const invertMode = useRef(0);
  const vortexMode = useRef(0);
  const freezeMode = useRef(0);
  const attractMode = useRef(false);
  const chaosMode = useRef(0);
  const blackholeMode = useRef<{ x: number; y: number; frames: number } | null>(null);
  const lastMouseMove = useRef(Date.now());
  const idleChecked = useRef(false);
  const mouseHistory = useRef<{ x: number; y: number; t: number }[]>([]);
  const lastShake = useRef(0);

  async function setupAudio() {
    if (analyserRef.current) return;

    const audio = new Audio("/song.mp3");
    audio.loop = true;
    audioRef.current = audio;

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    await audioCtx.resume();

    const source = audioCtx.createMediaElementSource(audio);

    // AudioWorklet runs in the audio rendering thread — 128-sample blocks
    // gives us 2.9ms max detection latency instead of 16ms with rAF
    await audioCtx.audioWorklet.addModule("/beat-detector.js");
    const worklet = new AudioWorkletNode(audioCtx, "beat-detector");
    workletRef.current = worklet;
    worklet.port.onmessage = (e) => {
      if (e.data.type === "kick") pendingKickRef.current = true;
    };

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;

    source.connect(worklet);
    worklet.connect(analyser);
    analyser.connect(audioCtx.destination);

    analyserRef.current = analyser;
    freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    timeDomainRef.current = new Uint8Array(analyser.fftSize);
  }

  const onFluxChange = useCallback((v: number) => {
    setFluxThreshold(v);
    workletRef.current?.port.postMessage({ fluxThreshold: v });
  }, []);

  const onRmsChange = useCallback((v: number) => {
    setRmsMultiplier(v);
    workletRef.current?.port.postMessage({ rmsMultiplier: v });
  }, []);

  function togglePlay() {
    setupAudio().then(() => {
      const audio = audioRef.current!;
      if (audio.paused) {
        audio.play();
        setPlaying(true);
      } else {
        audio.pause();
        setPlaying(false);
      }
    });
  }

  function getAudioLevels(): { bass: number } {
    const analyser = analyserRef.current;
    const freqData = freqDataRef.current;
    const timeData = timeDomainRef.current;
    if (!analyser || !freqData || !timeData) return { bass: 0 };

    // frequency domain
    analyser.getByteFrequencyData(freqData);

    // build smoothed spectrum for the visualizer
    if (!smoothedSpecRef.current || smoothedSpecRef.current.length !== freqData.length) {
      smoothedSpecRef.current = new Float32Array(freqData.length);
    }
    const spec = smoothedSpecRef.current;
    for (let i = 0; i < freqData.length; i++) {
      spec[i] = spec[i] * 0.72 + (freqData[i] / 255) * 0.28;
    }

    let bassSum = 0;
    for (let i = 0; i < 8; i++) bassSum += freqData[i];
    const bass = bassSum / (8 * 255);

    return { bass };
  }

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    function initParticles() {
      const dpr = window.devicePixelRatio || 1;
      const cols = Math.floor((canvas.width / dpr) / FONT_SIZE);
      const rows = Math.floor((canvas.height / dpr) / FONT_SIZE);
      particles.current = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * FONT_SIZE + FONT_SIZE / 2;
          const y = row * FONT_SIZE + FONT_SIZE;
          particles.current.push({
            x, y, homeX: x, homeY: y, vx: 0, vy: 0,
            char: randomChar(),
            charTimer: Math.floor(Math.random() * 200),
            charInterval: 180 + Math.floor(Math.random() * 200),
            panicRadius: 40 + Math.random() * 52,
            fleeAngleJitter: (Math.random() - 0.5) * 0.8,
          });
        }
      }
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.scale(dpr, dpr);
      initParticles();
    }

    function detectShake(x: number, y: number) {
      const now = Date.now();
      const hist = mouseHistory.current;
      hist.push({ x, y, t: now });
      if (hist.length > 12) hist.shift();
      if (hist.length < 8 || now - lastShake.current < 4000) return;
      let reversals = 0;
      for (let i = 2; i < hist.length; i++) {
        const dx1 = hist[i-1].x - hist[i-2].x;
        const dx2 = hist[i].x - hist[i-1].x;
        if (dx1 * dx2 < -200) reversals++;
      }
      if (reversals >= 3) { chaosMode.current = 240; lastShake.current = now; }
    }

    function onMouseMove(e: MouseEvent) {
      mouse.current = { x: e.clientX, y: e.clientY };
      lastMouseMove.current = Date.now();
      idleChecked.current = false;
      if (vortexMode.current > 0) vortexMode.current = 0;
      detectShake(e.clientX, e.clientY);
    }

    function onMouseLeave() { mouse.current = { x: -9999, y: -9999 }; }

    function onClick(e: MouseEvent) {
      const cx = e.clientX, cy = e.clientY;
      for (const p of particles.current) {
        const dx = p.x - cx, dy = p.y - cy;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 200 && dist > 0) {
          const force = ((200 - dist) / 200) * 18;
          p.vx += (dx/dist) * force;
          p.vy += (dy/dist) * force;
        }
      }
    }

    const lastClick = { t: 0 };
    function onDoubleClickCheck(e: MouseEvent) {
      const now = Date.now();
      if (now - lastClick.t < 350) blackholeMode.current = { x: e.clientX, y: e.clientY, frames: 360 };
      lastClick.t = now;
    }

    function onContextMenu(e: MouseEvent) { e.preventDefault(); freezeMode.current = 120; }
    function onMouseDown() { attractMode.current = true; }
    function onMouseUp() { attractMode.current = false; }

    function onKeyDown(e: KeyboardEvent) {
      const key = e.key.startsWith("Arrow") ? e.key : e.key.toLowerCase();
      if (key === KONAMI[konamiProgress.current]) {
        konamiProgress.current++;
        if (konamiProgress.current === KONAMI.length) { konamiProgress.current = 0; matrixMode.current = 300; }
      } else { konamiProgress.current = 0; }

      typedBuffer.current = (typedBuffer.current + e.key).slice(-10);
      const buf = typedBuffer.current.toLowerCase();
      if (buf.includes("doom")) { invertMode.current = 180; typedBuffer.current = ""; for (const p of particles.current) p.char = "!"; }
      if (buf.includes("wave")) { for (const p of particles.current) { p.vx += (Math.random()-0.5)*6; p.vy += Math.random()*-8; } typedBuffer.current = ""; }
      if (buf.includes("chaos")) { chaosMode.current = 300; typedBuffer.current = ""; }
    }

    function checkIdle() {
      if (audioRef.current && !audioRef.current.paused) return;
      if (!idleChecked.current && Date.now() - lastMouseMove.current > 8000) {
        idleChecked.current = true;
        vortexMode.current = 600;
      }
    }

    function tick() {
      timeRef.current++;
      const t = timeRef.current;

      checkIdle();

      const { bass: rawBass } = getAudioLevels();

      // smooth bass for wave modulation
      bassRef.current = bassRef.current * 0.6 + rawBass * 0.4;
      const bass = bassRef.current;

      // kick detection handled by AudioWorklet at 2.9ms resolution
      // pendingKickRef is set from the audio rendering thread via postMessage
      const kickFired = pendingKickRef.current;
      if (kickFired) {
        pendingKickRef.current = false;
        kickFlashRef.current = 1.0;
      }

      kickFlashRef.current *= 0.75;

      if (freezeMode.current > 0) {
        freezeMode.current--;
        ctx.fillStyle = "rgba(0,0,0,0.04)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const isMatrix = matrixMode.current > 0;
      const isInvert = invertMode.current > 0;
      const isVortex = vortexMode.current > 0;
      const isChaos = chaosMode.current > 0;
      const bh = blackholeMode.current;

      if (isMatrix) matrixMode.current--;
      if (isInvert) invertMode.current--;
      if (isVortex) vortexMode.current--;
      if (isChaos) chaosMode.current--;

      if (isInvert) {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      const mx = mouse.current.x;
      const my = mouse.current.y;
      const bhPhase = bh ? (bh.frames > 180 ? "suck" : "explode") : null;
      const bhExplodeProgress = bh && bhPhase === "explode" ? 1 - bh.frames / 180 : 0;
      if (bh) { bh.frames--; if (bh.frames <= 0) blackholeMode.current = null; }

      const kickFlash = kickFlashRef.current;

      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      if (kickFired) {
        // emanate from cursor, fall back to screen center if cursor is off screen
        const kx = mx > -999 ? mx : cx;
        const ky = mx > -999 ? my : cy;
        for (const p of particles.current) {
          const dx = p.homeX - kx;
          const dy = p.homeY - ky;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0) {
            const falloff = Math.max(0, 1 - dist / 900);
            const force = 6 * (0.4 + falloff * 0.6);
            p.vx += (dx / dist) * force;
            p.vy += (dy / dist) * force;
          }
        }
      }

      for (const p of particles.current) {
        const dx = p.x - mx, dy = p.y - my;
        const dist = Math.sqrt(dx*dx + dy*dy);

        if (bh) {
          const bx = p.x - bh.x;
          const by = p.y - bh.y;
          const bd = Math.sqrt(bx * bx + by * by);
          if (bhPhase === "suck" && bd > 6) {
            // strong constant pull — override damping so distant particles actually converge
            const force = 3;
            p.vx = p.vx * 0.94 - (bx / bd) * force;
            p.vy = p.vy * 0.94 - (by / bd) * force;
          } else if (bhPhase === "explode" && bd > 0) {
            // shockwave ring that sweeps outward
            const waveRadius = bhExplodeProgress * 600;
            const waveWidth = 100;
            const distFromWave = Math.abs(bd - waveRadius);
            if (distFromWave < waveWidth) {
              const t = 1 - distFromWave / waveWidth;
              p.vx += (bx / bd) * t * t * 30;
              p.vy += (by / bd) * t * t * 30;
            }
          }
        } else if (isChaos) {
          p.vx += (Math.random()-0.5)*3; p.vy += (Math.random()-0.5)*3;
        } else if (attractMode.current && dist < 300 && dist > 0) {
          const force = ((300-dist)/300)*1.2; p.vx -= (dx/dist)*force; p.vy -= (dy/dist)*force;
        } else if (isVortex && mx > -999) {
          const angle = Math.atan2(dy, dx) + 0.3;
          const pull = Math.max(0.5, (300-dist)/300)*0.4;
          p.vx -= Math.cos(angle)*pull; p.vy -= Math.sin(angle)*pull;
        } else if (dist < p.panicRadius && dist > 0) {
          const force = (p.panicRadius-dist)/p.panicRadius;
          const angle = Math.atan2(dy, dx) + p.fleeAngleJitter;
          p.vx += Math.cos(angle)*force*FLEE_FORCE;
          p.vy += Math.sin(angle)*force*FLEE_FORCE;
        } else {
          const waveX =
            Math.sin(t*WAVE_SPEED + p.homeY*WAVE_FREQ_Y) * WAVE_AMP_X +
            Math.cos(t*WAVE_SECONDARY_SPEED + p.homeX*WAVE_SECONDARY_FREQ) * WAVE_SECONDARY_AMP;
          const waveY =
            Math.cos(t*WAVE_SPEED + p.homeX*WAVE_FREQ_X) * WAVE_AMP_Y +
            Math.sin(t*WAVE_SECONDARY_SPEED + p.homeY*WAVE_SECONDARY_FREQ) * WAVE_SECONDARY_AMP;
          p.vx += (p.homeX + waveX - p.x) * RETURN_FORCE;
          p.vy += (p.homeY + waveY - p.y) * RETURN_FORCE;
        }

        p.vx *= DAMPING;
        p.vy *= DAMPING;
        p.x += p.vx;
        p.y += p.vy;

        p.charTimer--;
        if (p.charTimer <= 0) {
          if (!invertMode.current) p.char = randomChar();
          p.charTimer = isMatrix || isChaos ? 3 : p.charInterval;
        }

        const speed = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
        const kickGlow = Math.floor(kickFlash * 120);
        const bassGlow = Math.floor(bass * 60);

        if (isMatrix) {
          const g = Math.min(255, 80 + Math.floor(speed*20) + kickGlow + bassGlow);
          ctx.fillStyle = `rgb(0,${g},0)`;
        } else if (isInvert) {
          ctx.fillStyle = "black";
        } else {
          const brightness = Math.min(255, 130 + Math.floor(speed*12) + kickGlow + bassGlow);
          ctx.fillStyle = `rgb(${brightness},${brightness},${brightness})`;
        }

        ctx.font = `${FONT_SIZE}px monospace`;
        ctx.fillText(p.char, p.x, p.y);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("click", (e) => { onClick(e); onDoubleClickCheck(e); });
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("click", onClick);
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
      audioRef.current?.pause();
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} className="block w-full h-full" />

      {/* play/pause */}
      <button
        onClick={togglePlay}
        className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/30 hover:text-white/80 transition-colors font-mono text-xs tracking-widest"
      >
        {playing ? "[ pause ]" : "[ play ]"}
      </button>

      {/* knob panel */}
      <div className="absolute bottom-6 right-8 flex gap-6 items-end">
        <Knob
          label="sensitivity"
          value={fluxThreshold}
          min={0.01}
          max={0.2}
          decimals={3}
          onChange={onFluxChange}
        />
        <Knob
          label="threshold"
          value={rmsMultiplier}
          min={1.1}
          max={3.0}
          decimals={2}
          onChange={onRmsChange}
        />
      </div>
    </div>
  );
}
