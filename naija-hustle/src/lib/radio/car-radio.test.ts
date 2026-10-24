import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { CarRadio, type AudioLike, type RadioStation } from "./car-radio";

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stations: RadioStation[] = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  name: `Station ${i + 1}`,
  streamUrl: `https://stream.example.com/${i + 1}`,
}));

class FakeAudio implements AudioLike {
  src = "";
  volume = 1;
  preload = "";
  failPlay = false;
  private listeners = new Map<string, Array<() => void>>();
  async play() {
    if (this.failPlay) throw new Error("blocked");
    this.listeners.get("playing")?.forEach((l) => l());
  }
  pause() {}
  load() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
}

const flush = () => new Promise((r) => setImmediate(r));

function setup(overrides: Partial<ConstructorParameters<typeof CarRadio>[0]> = {}) {
  let clock = 1_000_000;
  const audios: FakeAudio[] = [];
  let fetches = 0;
  const radio = new CarRadio({
    fetchStations: async () => {
      fetches++;
      return stations;
    },
    random: mulberry32(42),
    now: () => clock,
    createAudio: () => {
      const a = new FakeAudio();
      audios.push(a);
      return a;
    },
    hasUserActivation: () => true,
    ...overrides,
  });
  return {
    radio,
    audios,
    fetches: () => fetches,
    advance: (ms: number) => {
      clock += ms;
      mock.timers.tick(ms);
    },
  };
}

describe("CarRadio", () => {
  it("only occasionally turns a radio on, never on every transition", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const t = setup();
      let transitions = 0;
      for (let i = 0; i < 400; i++) {
        t.radio.onLightTransition({ id: `car-${i % 25}` });
        transitions++;
        await flush();
        t.advance(9_000); // roughly one light change every 9 seconds
        await flush();
      }
      const started = t.audios.length;
      assert.ok(started > 0, "some radios should start");
      assert.ok(
        started < transitions * 0.2,
        `expected well under 20% of transitions, got ${started}/${transitions}`,
      );
      t.radio.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  it("never exceeds the concurrency cap", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const t = setup({
        chancePerTransition: 1,
        globalGapMs: 0,
        maxConcurrent: 2,
      });
      for (let i = 0; i < 10; i++) {
        t.radio.onLightTransition({ id: `car-${i}` });
        await flush();
      }
      assert.equal(t.radio.getNowPlaying().length, 2);
      t.radio.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  it("gives a car a cooldown after its radio goes off", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const t = setup({
        chancePerTransition: 1,
        globalGapMs: 0,
        playMs: [1_000, 1_000],
        carCooldownMs: [60_000, 60_000],
        fadeMs: 100,
      });
      t.radio.onLightTransition({ id: "a" });
      await flush();
      assert.equal(t.audios.length, 1);
      t.advance(1_000); // play time is up, fade-out begins
      t.advance(200); // fade-out completes
      assert.equal(t.radio.getNowPlaying().length, 0);
      t.radio.onLightTransition({ id: "a" });
      await flush();
      assert.equal(t.audios.length, 1, "still cooling down");
      t.advance(61_000);
      t.radio.onLightTransition({ id: "a" });
      await flush();
      assert.equal(t.audios.length, 2, "cooldown over");
      t.radio.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  it("does nothing, and does not fetch, before the visitor interacts", async () => {
    const t = setup({ chancePerTransition: 1, hasUserActivation: () => false });
    t.radio.onLightTransition({ id: "a" });
    await flush();
    assert.equal(t.audios.length, 0);
    assert.equal(t.fetches(), 0);
    t.radio.dispose();
  });

  it("skips cars that are too far away to hear", async () => {
    const t = setup({ chancePerTransition: 1 });
    t.radio.onLightTransition({ id: "far", proximity: 0.01 });
    await flush();
    assert.equal(t.audios.length, 0);
    t.radio.dispose();
  });

  it("drops a failing station, reports it, and stays quiet instead of throwing", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const errors: string[] = [];
      const t = setup({
        chancePerTransition: 1,
        globalGapMs: 0,
        createAudio: () => {
          const a = new FakeAudio();
          a.failPlay = true;
          return a;
        },
        onPlaybackError: ({ station }) => errors.push(String(station.id)),
      });
      t.radio.onLightTransition({ id: "a" });
      await flush();
      assert.equal(errors.length, 1);
      assert.equal(t.radio.getNowPlaying().length, 0);
      t.radio.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  it("ignores unusable stream URLs, and http ones on https pages", async () => {
    const t = setup({
      chancePerTransition: 1,
      httpsOnly: true,
      fetchStations: async () => [
        { id: 1, name: "Plain http", streamUrl: "http://stream.example.com/1" },
        { id: 2, name: "Broken", streamUrl: "not a url" },
        { id: 3, name: "Good", streamUrl: "https://stream.example.com/3" },
      ],
    });
    t.radio.onLightTransition({ id: "a" });
    await flush();
    assert.equal(t.audios[0]?.src, "https://stream.example.com/3");
    t.radio.dispose();
  });
});
