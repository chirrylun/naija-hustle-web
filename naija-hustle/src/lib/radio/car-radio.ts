// Ambient car radios for the traffic scene.
//
// Call `onLightTransition(car)` whenever a car sits at a light change. Most of
// the time nothing happens; occasionally that car "turns on its radio" and a
// real Nigerian station plays for a short while, then fades out. Several
// guards keep it feeling natural rather than mechanical:
//
//  - a low chance per transition (never every light),
//  - a per-car cooldown after its radio goes off,
//  - a minimum gap between any two radios starting, and a cap on how many play
//    at once,
//  - each car has a loose "taste" so it tends to favour the same stations,
//  - nothing starts (or is even fetched) until the visitor has interacted with
//    the page, because browsers block audio before that.
//
// This file has no React or Pixi dependency, so any scene code can use it.

export type RadioStation = {
  id: string | number;
  name: string;
  streamUrl: string;
  [key: string]: unknown;
};

export type CarRef = {
  /** Stable id for the car, used for cooldowns and station taste. */
  id: string;
  /** 0..1 loudness, e.g. from distance to the camera. Defaults to 1. */
  proximity?: number;
};

export type NowPlaying = {
  carId: string;
  station: RadioStation;
  status: "starting" | "playing";
};

/** The slice of HTMLAudioElement the controller relies on. */
export type AudioLike = {
  src: string;
  volume: number;
  preload: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
};

type Range = readonly [min: number, max: number];

export type CarRadioOptions = {
  /** Loads one page of stations. Called lazily, and only once on success. */
  fetchStations: () => Promise<RadioStation[]>;
  /** Chance (0..1) that a given light transition turns a radio on. */
  chancePerTransition?: number;
  /** How long a radio stays on, ms. */
  playMs?: Range;
  /** How long a car stays quiet after its radio goes off, ms. */
  carCooldownMs?: Range;
  /** Minimum time between any two radios starting, ms. */
  globalGapMs?: number;
  /** Most radios audible at once. */
  maxConcurrent?: number;
  /** Loudest a radio gets at proximity 1. */
  maxVolume?: number;
  fadeMs?: number;
  /** Cars quieter than this (after proximity scaling) are skipped. */
  minAudibleVolume?: number;
  /** Chance a car picks a station from its own taste rather than at random. */
  tasteBias?: number;
  /** Only allow https streams (set true on https pages: http is blocked). */
  httpsOnly?: boolean;
  /** Has the visitor interacted with the page yet? */
  hasUserActivation?: () => boolean;
  onPlaybackError?: (info: { carId: string; station: RadioStation }) => void;
  // Injectable for tests.
  random?: () => number;
  now?: () => number;
  createAudio?: () => AudioLike;
};

const DEFAULTS = {
  chancePerTransition: 0.12,
  playMs: [12_000, 30_000] as Range,
  carCooldownMs: [45_000, 120_000] as Range,
  globalGapMs: 6_000,
  maxConcurrent: 2,
  maxVolume: 0.5,
  fadeMs: 1_200,
  minAudibleVolume: 0.05,
  tasteBias: 0.6,
};

const FADE_STEP_MS = 50;

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type ActiveRadio = {
  carId: string;
  station: RadioStation;
  audio: AudioLike;
  targetVolume: number;
  status: "starting" | "playing";
  stopTimer: ReturnType<typeof setTimeout> | null;
  fadeTimer: ReturnType<typeof setInterval> | null;
  stopped: boolean;
};

export class CarRadio {
  private readonly o: Required<
    Omit<CarRadioOptions, "onPlaybackError" | "hasUserActivation">
  > &
    Pick<CarRadioOptions, "onPlaybackError" | "hasUserActivation">;

  private stations: RadioStation[] | null = null;
  private loading: Promise<RadioStation[] | null> | null = null;
  private readonly active = new Map<string, ActiveRadio>();
  private readonly pendingCars = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly badStations = new Set<string>();
  private readonly listeners = new Set<(playing: NowPlaying[]) => void>();
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(options: CarRadioOptions) {
    const { onPlaybackError, hasUserActivation, ...rest } = options;
    this.o = {
      ...DEFAULTS,
      httpsOnly: false,
      random: Math.random,
      now: Date.now,
      createAudio: () => new Audio() as unknown as AudioLike,
      ...stripUndefined(rest),
      onPlaybackError,
      hasUserActivation,
    } as CarRadio["o"];
  }

  /** Call when a car is at a traffic-light transition. Usually does nothing. */
  onLightTransition(car: CarRef): void {
    if (this.disposed) return;
    if (this.active.has(car.id) || this.pendingCars.has(car.id)) return;

    const volume = this.o.maxVolume * clamp01(car.proximity ?? 1);
    if (volume < this.o.minAudibleVolume) return;
    if (this.o.hasUserActivation && !this.o.hasUserActivation()) return;

    const now = this.o.now();
    if ((this.cooldownUntil.get(car.id) ?? 0) > now) return;
    if (now - this.lastStartAt < this.o.globalGapMs) return;
    if (this.active.size + this.pendingCars.size >= this.o.maxConcurrent) return;
    if (this.o.random() >= this.o.chancePerTransition) return;

    void this.start(car.id, volume);
  }

  /** Turn one car's radio off (e.g. the car left the scene). */
  stopCar(carId: string): void {
    const radio = this.active.get(carId);
    if (radio) this.fadeOutAndStop(radio, false);
  }

  /** Stop everything immediately and release streams. */
  dispose(): void {
    this.disposed = true;
    for (const radio of [...this.active.values()]) this.teardown(radio);
    this.pendingCars.clear();
    this.listeners.clear();
  }

  getNowPlaying(): NowPlaying[] {
    return [...this.active.values()].map(({ carId, station, status }) => ({
      carId,
      station,
      status,
    }));
  }

  subscribe(listener: (playing: NowPlaying[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- internals ----

  private async start(carId: string, volume: number): Promise<void> {
    this.pendingCars.add(carId);
    try {
      const stations = await this.loadStations();
      if (this.disposed || !stations) return;

      const station = this.pickStation(carId, stations);
      if (!station) return;

      // Re-check capacity: the fetch may have taken a moment.
      if (this.active.size >= this.o.maxConcurrent) return;

      const audio = this.o.createAudio();
      audio.preload = "none";
      audio.volume = 0;

      const radio: ActiveRadio = {
        carId,
        station,
        audio,
        targetVolume: volume,
        status: "starting",
        stopTimer: null,
        fadeTimer: null,
        stopped: false,
      };

      audio.addEventListener("error", () => this.handlePlaybackError(radio));
      audio.addEventListener("playing", () => {
        if (radio.stopped) return;
        radio.status = "playing";
        this.emit();
      });

      this.active.set(carId, radio);
      this.lastStartAt = this.o.now();
      this.emit();

      audio.src = station.streamUrl;
      try {
        await audio.play();
      } catch {
        // Autoplay blocked, or the stream could not start.
        this.handlePlaybackError(radio);
        return;
      }
      if (radio.stopped) return;

      this.fadeTo(radio, radio.targetVolume);
      const playFor = this.randomBetween(this.o.playMs);
      radio.stopTimer = setTimeout(
        () => this.fadeOutAndStop(radio, true),
        playFor,
      );
    } finally {
      this.pendingCars.delete(carId);
    }
  }

  private async loadStations(): Promise<RadioStation[] | null> {
    if (this.stations) return this.stations;
    if (!this.loading) {
      this.loading = this.o
        .fetchStations()
        .then((list) => {
          const usable = list.filter((s) => this.isUsable(s));
          this.stations = usable.length > 0 ? usable : null;
          return this.stations;
        })
        .catch(() => null)
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  private isUsable(station: RadioStation): boolean {
    if (!station || typeof station.streamUrl !== "string") return false;
    try {
      const url = new URL(station.streamUrl);
      if (url.protocol === "https:") return true;
      return url.protocol === "http:" && !this.o.httpsOnly;
    } catch {
      return false;
    }
  }

  private pickStation(
    carId: string,
    stations: RadioStation[],
  ): RadioStation | null {
    const playing = new Set(
      [...this.active.values()].map((r) => String(r.station.id)),
    );
    const candidates = stations.filter(
      (s) => !this.badStations.has(String(s.id)) && !playing.has(String(s.id)),
    );
    if (candidates.length === 0) return null;

    if (this.o.random() < this.o.tasteBias) {
      // Walk from the car's favourite spot so the same car tends to land on
      // the same few stations, skipping any that are unavailable right now.
      const start = hashString(carId) % candidates.length;
      const taste = Math.floor(this.o.random() * Math.min(3, candidates.length));
      return candidates[(start + taste) % candidates.length] ?? null;
    }
    return candidates[Math.floor(this.o.random() * candidates.length)] ?? null;
  }

  private handlePlaybackError(radio: ActiveRadio): void {
    if (radio.stopped) return;
    this.badStations.add(String(radio.station.id));
    this.teardown(radio);
    this.cooldownUntil.set(
      radio.carId,
      this.o.now() + this.randomBetween(this.o.carCooldownMs),
    );
    this.o.onPlaybackError?.({ carId: radio.carId, station: radio.station });
  }

  private fadeOutAndStop(radio: ActiveRadio, coolDown: boolean): void {
    if (radio.stopped) return;
    if (radio.stopTimer) clearTimeout(radio.stopTimer);
    radio.stopTimer = null;
    if (coolDown) {
      this.cooldownUntil.set(
        radio.carId,
        this.o.now() + this.randomBetween(this.o.carCooldownMs),
      );
    }
    this.fadeTo(radio, 0, () => this.teardown(radio));
  }

  private fadeTo(radio: ActiveRadio, target: number, done?: () => void): void {
    if (radio.fadeTimer) clearInterval(radio.fadeTimer);
    const steps = Math.max(1, Math.round(this.o.fadeMs / FADE_STEP_MS));
    const from = radio.audio.volume;
    let i = 0;
    radio.fadeTimer = setInterval(() => {
      i++;
      radio.audio.volume = clamp01(from + ((target - from) * i) / steps);
      if (i >= steps) {
        if (radio.fadeTimer) clearInterval(radio.fadeTimer);
        radio.fadeTimer = null;
        done?.();
      }
    }, FADE_STEP_MS);
  }

  private teardown(radio: ActiveRadio): void {
    if (radio.stopped) return;
    radio.stopped = true;
    if (radio.stopTimer) clearTimeout(radio.stopTimer);
    if (radio.fadeTimer) clearInterval(radio.fadeTimer);
    try {
      radio.audio.pause();
      // Drop the source so the browser closes the live stream connection.
      radio.audio.removeAttribute("src");
      radio.audio.load();
    } catch {
      // Nothing useful to do if the element is already gone.
    }
    if (this.active.get(radio.carId) === radio) this.active.delete(radio.carId);
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getNowPlaying();
    for (const listener of this.listeners) listener(snapshot);
  }

  private randomBetween([min, max]: Range): number {
    return min + this.o.random() * (max - min);
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
