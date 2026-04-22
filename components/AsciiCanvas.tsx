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
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const timeDomainRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const bassRef = useRef(0);
  // drop detection — just track kick gaps
  const lastKickFrameRef = useRef(0);
  // debug display
  const [debugInfo, setDebugInfo] = useState({ gap: 0, inGap: false });
  const debugTickRef = useRef(0);
  const songSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const muteGainRef = useRef<GainNode | null>(null);

  // beat detection
  const kickFlashRef = useRef(0);
  const workletRef = useRef<AudioWorkletNode | null>(null);

  const [fluxThreshold, setFluxThreshold] = useState(0.05);
  const [rmsMultiplier, setRmsMultiplier] = useState(1.5);

  // visualizer
  const smoothedSpecRef = useRef<Float32Array | null>(null);
  const pendingKickRef = useRef(false);

  // live audio (BlackHole / mic)
  const liveStreamRef = useRef<MediaStream | null>(null);
  const liveSrcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const liveOnRef = useRef(false);
  const [liveOn, setLiveOn] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [showDevicePicker, setShowDevicePicker] = useState(false);

  // lasers
  interface Laser { frames: number; total: number; beams: { x: number; width: number; drift: number }[]; strobePhase: number; }
  const laserRef = useRef<Laser | null>(null);
  const LASER_PRESETS: { name: string; rgb: [number, number, number] }[] = [
    { name: "red",    rgb: [255, 20, 20] },
    { name: "purple", rgb: [180, 0, 255] },
    { name: "green",  rgb: [0, 255, 60] },
    { name: "cyan",   rgb: [0, 200, 255] },
    { name: "pink",   rgb: [255, 20, 180] },
  ];
  const laserColorRef = useRef<[number, number, number]>([255, 20, 20]);
  const [laserColor, setLaserColor] = useState<[number, number, number]>([255, 20, 20]);
  const [laserChance, setLaserChance] = useState(0.05);
  const laserChanceRef = useRef(0.05);
  // manual BPM — used to quantize laser duration to bars
  const [bpm, setBpm] = useState(146);
  const bpmRef = useRef(146);

  // pillars — 4 vertical strobing columns in a C shape (2 front, 2 back)
  interface PillarBurst { frames: number; pillars: { x: number; width: number; back: boolean }[]; strobePhase: number; }
  const pillarsRef = useRef<PillarBurst | null>(null);
  const [pillarChance, setPillarChance] = useState(0);
  const pillarChanceRef = useRef(0);

  // CO2 jets — hold 'c', spread grows the longer you hold
  interface Co2Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number; }
  const co2ParticlesRef = useRef<Co2Particle[]>([]);
  const co2HeldRef = useRef(false);
  const co2SpreadRef = useRef(0); // 0 = concentrated, 1 = full stage width
  function pickLaserColor(rgb: [number, number, number]) {
    laserColorRef.current = rgb;
    setLaserColor(rgb);
  }

  // camera
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  // brightness-ordered chars for camera (light → dense)
  const DENSITY = " .,:;|!(){}[]?/\\*&#@";

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

  async function toggleCamera() {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(t => t.stop());
      cameraStreamRef.current = null;
      cameraVideoRef.current = null;
      cameraOffscreenRef.current = null;
      setCameraOn(false);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    cameraStreamRef.current = stream;

    const video = document.createElement("video");
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    await video.play();
    cameraVideoRef.current = video;

    const offscreen = document.createElement("canvas");
    cameraOffscreenRef.current = offscreen;
    setCameraOn(true);
  }

  async function setupAudioContext() {
    if (audioCtxRef.current) return;

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    await audioCtx.resume();

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

    // mute gain — used during live mode so desktop audio isn't re-output to speakers
    const muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;
    muteGain.connect(audioCtx.destination);
    muteGainRef.current = muteGain;

    worklet.connect(analyser);
    analyser.connect(audioCtx.destination); // song mode: audio reaches speakers

    analyserRef.current = analyser;
    freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    timeDomainRef.current = new Uint8Array(analyser.fftSize);
  }

  async function setupAudio() {
    await setupAudioContext();
    if (audioRef.current) return;

    const audio = new Audio("/song.mp3");
    audio.loop = true;
    audioRef.current = audio;

    const src = audioCtxRef.current!.createMediaElementSource(audio);
    songSrcRef.current = src;
    src.connect(workletRef.current!);
  }

  async function startLive(deviceId?: string) {
    setShowDevicePicker(false);
    await setupAudioContext();

    // lazily create muteGain if missing (handles hot-reload ref reset)
    if (!muteGainRef.current && audioCtxRef.current) {
      const muteGain = audioCtxRef.current.createGain();
      muteGain.gain.value = 0;
      muteGain.connect(audioCtxRef.current.destination);
      muteGainRef.current = muteGain;
    }

    // mute speakers so desktop audio isn't doubled
    try { analyserRef.current!.disconnect(audioCtxRef.current!.destination); } catch {}
    analyserRef.current!.connect(muteGainRef.current!);

    // disconnect song source to avoid mixing with live signal
    songSrcRef.current?.disconnect();
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setPlaying(false);
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    liveStreamRef.current = stream;

    const liveSrc = audioCtxRef.current!.createMediaStreamSource(stream);
    liveSrcRef.current = liveSrc;
    liveSrc.connect(workletRef.current!);

    liveOnRef.current = true;
    setLiveOn(true);
  }

  async function toggleLive() {
    if (liveOnRef.current) {
      // turn off — stop stream, restore song path
      liveStreamRef.current?.getTracks().forEach(t => t.stop());
      liveStreamRef.current = null;
      liveSrcRef.current?.disconnect();
      liveSrcRef.current = null;

      // reconnect song source and restore audio output to speakers
      songSrcRef.current?.connect(workletRef.current!);
      try { analyserRef.current?.disconnect(muteGainRef.current!); } catch {}
      analyserRef.current?.connect(audioCtxRef.current!.destination);

      liveOnRef.current = false;
      setLiveOn(false);
      return;
    }

    // request mic permission first so device labels are populated
    await navigator.mediaDevices.getUserMedia({ audio: true })
      .then(s => s.getTracks().forEach(t => t.stop()))
      .catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === "audioinput");

    if (inputs.length <= 1) {
      await startLive(inputs[0]?.deviceId);
    } else {
      setAudioInputs(inputs);
      setShowDevicePicker(true);
    }
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
      if (key === "c") co2HeldRef.current = true;

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

    function onKeyUp(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "c") co2HeldRef.current = false;
    }

    function checkIdle() {
      if (liveOnRef.current) return;
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

      // --- drop detection: kick gap tracking ---
      // how many frames since the last kick?
      const kickGap = t - lastKickFrameRef.current;
      const kickGapSec = kickGap / 60;
      const inGap = kickGap > 90; // ~1.5s without a kick = breakdown

      // update debug overlay
      debugTickRef.current++;
      if (debugTickRef.current % 30 === 0) {
        setDebugInfo({ gap: Math.round(kickGapSec * 10) / 10, inGap });
      }

      // kick detection handled by AudioWorklet at 2.9ms resolution
      const kickFired = pendingKickRef.current;
      if (kickFired) {
        pendingKickRef.current = false;
        kickFlashRef.current = 1.0;

        // drop = first kick after a real gap (kicks were absent >1.5s)
        const isDrop = inGap && t > 180; // skip first 3s of track

        lastKickFrameRef.current = t;

        if (isDrop && !laserRef.current) {
          // always fire on a drop
          const count = 3 + Math.floor(Math.random() * 5);
          laserRef.current = {
            frames: Math.round(((60 / bpmRef.current) * [1, 2, 2, 4][Math.floor(Math.random() * 4)]) * 60),
            total: 0,
            beams: Array.from({ length: count }, () => ({
              x: Math.random() * window.innerWidth,
              width: 1 + Math.random() * 2,
              drift: (Math.random() - 0.5) * window.innerWidth * 0.6,
            })),
            strobePhase: 0,
          };
        } else if (!isDrop && !laserRef.current && Math.random() < laserChanceRef.current) {
          // fallback: probabilistic on regular kicks
          const count = 3 + Math.floor(Math.random() * 5);
          laserRef.current = {
            frames: Math.round(((60 / bpmRef.current) * [1, 2, 2, 4][Math.floor(Math.random() * 4)]) * 60),
            total: 0,
            beams: Array.from({ length: count }, () => ({
              x: Math.random() * window.innerWidth,
              width: 1 + Math.random() * 2,
              drift: (Math.random() - 0.5) * window.innerWidth * 0.6,
            })),
            strobePhase: 0,
          };
        }

        // pillars fire independently — knob controls all firing (0 = fully off)
        if (pillarChanceRef.current > 0 && !pillarsRef.current && (isDrop || Math.random() < pillarChanceRef.current)) {
          const w = window.innerWidth;
          pillarsRef.current = {
            frames: Math.round(((60 / bpmRef.current) * [1, 2, 2, 4][Math.floor(Math.random() * 4)]) * 60),
            strobePhase: 0,
            pillars: [
              // front pair — wider, closer to edges
              { x: w * 0.18, width: 70, back: false },
              { x: w * 0.82, width: 70, back: false },
              // back pair — thinner, pulled toward center (fake depth)
              { x: w * 0.38, width: 34, back: true },
              { x: w * 0.62, width: 34, back: true },
            ],
          };
        }
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

      // compute laser strobe state here so particle colors and beam drawing use the same value
      const laser = laserRef.current;
      let laserStrobeOn = false;
      if (laser) {
        laser.strobePhase++;
        laserStrobeOn = laser.strobePhase % 5 < 3;
      }

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

      // sample camera frame into a pixel grid matching the char grid
      const dpr = window.devicePixelRatio || 1;
      const gridCols = Math.floor((canvas.width / dpr) / FONT_SIZE);
      const gridRows = Math.floor((canvas.height / dpr) / FONT_SIZE);
      let cameraPixels: Uint8ClampedArray | null = null;

      const camVideo = cameraVideoRef.current;
      const camOffscreen = cameraOffscreenRef.current;
      if (camVideo && camOffscreen && camVideo.readyState >= 2) {
        camOffscreen.width = gridCols;
        camOffscreen.height = gridRows;
        const oc = camOffscreen.getContext("2d", { willReadFrequently: true })!;
        oc.setTransform(-1, 0, 0, 1, gridCols, 0); // mirror horizontally
        oc.drawImage(camVideo, 0, 0, gridCols, gridRows);
        oc.setTransform(1, 0, 0, 1, 0, 0); // reset
        cameraPixels = oc.getImageData(0, 0, gridCols, gridRows).data;
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
        } else if (cameraPixels) {
          // camera mode: snap back to home, char driven by pixel brightness
          p.vx += (p.homeX - p.x) * 0.12;
          p.vy += (p.homeY - p.y) * 0.12;
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

        // camera: override char and color with pixel data
        if (cameraPixels) {
          const col = Math.min(gridCols - 1, Math.floor(p.homeX / FONT_SIZE));
          const row = Math.min(gridRows - 1, Math.floor(p.homeY / FONT_SIZE));
          const idx = (row * gridCols + col) * 4;
          const r = cameraPixels[idx];
          const g2 = cameraPixels[idx + 1];
          const b2 = cameraPixels[idx + 2];
          const luma = (r * 0.299 + g2 * 0.587 + b2 * 0.114) / 255;

          // map luma to char — higher brightness = denser char
          const charIdx = Math.min(DENSITY.length - 1, Math.floor(luma * DENSITY.length));
          p.char = DENSITY[charIdx];

          // always render bright enough to see — scale from 80 to 255 based on luma
          const speed = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
          const kickGlow = Math.floor(kickFlash * 100);
          const vis = Math.min(255, 80 + Math.floor(luma * 175) + Math.floor(speed * 10) + kickGlow);

          if (laserStrobeOn) {
            const [lr, lg, lb] = laserColorRef.current;
            const cr = Math.min(255, 30 + Math.floor((vis - 30) * (lr / 255)));
            const cg = Math.min(255, 30 + Math.floor((vis - 30) * (lg / 255)));
            const cb = Math.min(255, 30 + Math.floor((vis - 30) * (lb / 255)));
            ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          } else {
            ctx.fillStyle = `rgb(${vis},${vis},${vis})`;
          }
        } else {
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
          } else if (laserStrobeOn) {
            const brightness = Math.min(255, 130 + Math.floor(speed*12) + kickGlow + bassGlow);
            const [lr, lg, lb] = laserColorRef.current;
            const cr = Math.min(255, 30 + Math.floor((brightness - 30) * (lr / 255)));
            const cg = Math.min(255, 30 + Math.floor((brightness - 30) * (lg / 255)));
            const cb = Math.min(255, 30 + Math.floor((brightness - 30) * (lb / 255)));
            ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          } else {
            const brightness = Math.min(255, 130 + Math.floor(speed*12) + kickGlow + bassGlow);
            ctx.fillStyle = `rgb(${brightness},${brightness},${brightness})`;
          }
        }

        ctx.font = `${FONT_SIZE}px monospace`;
        ctx.fillText(p.char, p.x, p.y);
      }

      // --- pillars — 4 vertical strobing columns in a C shape ---
      const pb = pillarsRef.current;
      if (pb) {
        pb.frames--;
        pb.strobePhase++;
        if (pb.frames <= 0) {
          pillarsRef.current = null;
        } else {
          // fast strobe: 2 frames on, 2 frames off (~15Hz)
          const strobeOn = pb.strobePhase % 4 < 2;
          if (strobeOn) {
            const h = window.innerHeight;
            const topY = h * 0.4; // pillars rise from bottom to 60% of height
            const fadeOut = Math.min(1, pb.frames / 30);
            ctx.save();
            ctx.shadowColor = "white";
            ctx.shadowBlur = 25;
            for (const p of pb.pillars) {
              // back pillars are thinner + dimmer (fake depth)
              const alpha = (p.back ? 0.45 : 0.85) * fadeOut;
              ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
              ctx.fillRect(p.x - p.width / 2, topY, p.width, h - topY);
            }
            ctx.restore();
          }
        }
      }

      // --- lasers ---
      if (laser) {
        laser.frames--;

        if (laser.frames <= 0) {
          laserRef.current = null;
        } else {
          const fadeOut = Math.min(1, laser.frames / 30);

          if (laserStrobeOn) {
            const [lr, lg, lb] = laserColorRef.current;
            const h = window.innerHeight;
            ctx.save();
            ctx.shadowColor = `rgb(${lr},${lg},${lb})`;
            ctx.shadowBlur = 18;

            for (const beam of laser.beams) {
              const x2 = beam.x + beam.drift;

              // core beam
              ctx.beginPath();
              ctx.moveTo(beam.x, 0);
              ctx.lineTo(x2, h);
              ctx.strokeStyle = `rgba(${lr},${lg},${lb},${0.9 * fadeOut})`;
              ctx.lineWidth = beam.width;
              ctx.stroke();

              // wider soft glow
              ctx.beginPath();
              ctx.moveTo(beam.x, 0);
              ctx.lineTo(x2, h);
              ctx.strokeStyle = `rgba(${lr},${lg},${lb},${0.12 * fadeOut})`;
              ctx.lineWidth = beam.width * 10;
              ctx.stroke();
            }

            ctx.restore();
          }
        }
      }

      // --- CO2 jets — hold 'c' ---
      // spread grows while held, decays when released
      if (co2HeldRef.current) {
        co2SpreadRef.current = Math.min(1, co2SpreadRef.current + 1 / 150); // fully spread in ~2.5s
      } else {
        co2SpreadRef.current *= 0.95; // decay when released
      }

      if (co2HeldRef.current) {
        const h = window.innerHeight;
        const w = window.innerWidth;
        const spread = co2SpreadRef.current;

        // anchor emitters at 25% and 75% — these always fire while held
        const emitters: number[] = [w * 0.25, w * 0.75];

        // add extra random emitters as spread grows (0 → 5)
        const extraCount = Math.floor(spread * 5);
        for (let i = 0; i < extraCount; i++) {
          emitters.push(Math.random() * w);
        }

        // total particle budget split across emitters — keeps density from exploding
        const totalParticles = 12 + Math.floor(spread * 12); // 12 → 24
        const perEmitter = Math.max(2, Math.floor(totalParticles / emitters.length));

        for (const ex of emitters) {
          for (let i = 0; i < perEmitter; i++) {
            co2ParticlesRef.current.push({
              x: ex + (Math.random() - 0.5) * 30,
              y: h + 10,
              vx: (Math.random() - 0.5) * 2.2,
              vy: -(13 + Math.random() * 6),
              life: 60 + Math.random() * 30,
              maxLife: 90,
              size: 14 + Math.random() * 10,
            });
          }
        }
      }

      // update + render CO2 particles
      const co2 = co2ParticlesRef.current;
      if (co2.length > 0) {
        ctx.save();
        ctx.shadowColor = "white";
        ctx.shadowBlur = 30;
        for (let i = co2.length - 1; i >= 0; i--) {
          const p = co2[i];
          p.x += p.vx;
          p.y += p.vy;
          p.vy *= 0.96; // decelerate as it rises
          p.vx *= 0.98;
          p.vy += 0.03; // tiny gravity to help plume settle
          p.size += 0.5; // expand as it dissipates
          p.life--;

          if (p.life <= 0 || p.y < -50) {
            co2.splice(i, 1);
            continue;
          }

          const alpha = Math.min(1, p.life / p.maxLife) * 0.55;
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
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
    window.addEventListener("keyup", onKeyUp);
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
      window.removeEventListener("keyup", onKeyUp);
      audioRef.current?.pause();
      liveStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} className="block w-full h-full" />

      {/* drop detection debug — remove when tuned */}
      <div className="absolute top-6 left-6 font-mono text-[10px] text-white/50 space-y-0.5 pointer-events-none">
        <div>kick gap: {debugInfo.gap}s</div>
        <div className={debugInfo.inGap ? "text-yellow-400/80" : ""}>
          {debugInfo.inGap ? "▼ no kicks (drop next)" : "kicks active"}
        </div>
      </div>

      {/* play/pause */}
      <button
        onClick={togglePlay}
        className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/30 hover:text-white/80 transition-colors font-mono text-xs tracking-widest"
      >
        {playing ? "[ pause ]" : "[ play ]"}
      </button>

      {/* camera + live toggles */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2 flex gap-6 items-start">
        <button
          onClick={toggleCamera}
          className={`font-mono text-xs tracking-widest transition-colors ${cameraOn ? "text-white/80" : "text-white/25 hover:text-white/60"}`}
        >
          {cameraOn ? "[ cam on ]" : "[ cam ]"}
        </button>
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={toggleLive}
            className={`font-mono text-xs tracking-widest transition-colors ${liveOn ? "text-red-400/90" : "text-white/25 hover:text-white/60"}`}
          >
            {liveOn ? "[ live on ]" : "[ live ]"}
          </button>
          {showDevicePicker && (
            <div className="flex flex-col gap-1 mt-1">
              {audioInputs.map(d => (
                <button
                  key={d.deviceId}
                  onClick={() => startLive(d.deviceId)}
                  className="font-mono text-[10px] tracking-widest text-white/50 hover:text-white/90 transition-colors text-left"
                >
                  {d.label || `input ${d.deviceId.slice(0, 6)}`}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* knob panel */}
      <div className="absolute bottom-6 right-8 flex gap-6 items-end">
        {/* laser color presets */}
        <div className="flex flex-col items-center gap-2 mb-1">
          <div className="flex gap-2">
            {LASER_PRESETS.map(p => {
              const [r, g, b] = p.rgb;
              const active = laserColor[0] === r && laserColor[1] === g && laserColor[2] === b;
              return (
                <button
                  key={p.name}
                  onClick={() => pickLaserColor(p.rgb)}
                  style={{ background: `rgb(${r},${g},${b})`, boxShadow: active ? `0 0 8px rgb(${r},${g},${b})` : "none" }}
                  className={`w-3 h-3 rounded-full transition-all ${active ? "scale-125" : "opacity-40 hover:opacity-80"}`}
                />
              );
            })}
          </div>
          <span className="font-mono text-white/30 text-[9px] tracking-[0.2em] uppercase">laser</span>
        </div>
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
        <Knob
          label="laser freq"
          value={laserChance}
          min={0}
          max={0.3}
          decimals={2}
          onChange={(v) => { laserChanceRef.current = v; setLaserChance(v); }}
        />
        <Knob
          label="pillar freq"
          value={pillarChance}
          min={0}
          max={0.3}
          decimals={2}
          onChange={(v) => { pillarChanceRef.current = v; setPillarChance(v); }}
        />
        <Knob
          label="bpm"
          value={bpm}
          min={60}
          max={200}
          decimals={0}
          onChange={(v) => { bpmRef.current = Math.round(v); setBpm(Math.round(v)); }}
        />
      </div>
    </div>
  );
}
