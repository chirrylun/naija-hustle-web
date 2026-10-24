# Car radios

Cars occasionally play a real Nigerian radio station while stopped at a light.

## Setup

Set these in the **server** environment (`.env.local` for local dev, and the
hosting provider's secret settings for production), then restart/redeploy:

```
NAIJA_RADIO_API_KEY=nr_your_key_here
NAIJA_RADIO_API_BASE_URL=https://fm.puzzofme.com/api/v1
```

Never put the key in a `NEXT_PUBLIC_` variable, frontend code, a URL, or a
committed file. The browser only talks to our own `GET /api/radio-stations`
route, which adds the key server-side. Audio is not relayed: the browser plays
each station's `streamUrl` directly from the broadcaster.

## Use

```tsx
const radio = useCarRadio();

// whenever a car is at a light change:
radio.onLightTransition({ id: car.id, proximity: 0.8 });

// when a car leaves the scene:
radio.stopCar(car.id);

// radio.nowPlaying -> [{ carId, station, status }] for "♪ Station" bubbles
```

Outside React, use `CarRadio` from `car-radio.ts` directly.

## Tuning

Defaults are in `car-radio.ts` and can be overridden via `useCarRadio({...})`:
`chancePerTransition` (0.12), `playMs`, `carCooldownMs`, `globalGapMs`,
`maxConcurrent`, `maxVolume`.

Notes:

- Nothing is fetched or played until the visitor has clicked/tapped/pressed a key
  (browsers block audio before that).
- Only the first 100 stations are loaded. More pages are available from the
  route with `?offset=<pagination.nextOffset>`.
- Stations that fail to play are skipped for the rest of the session.
- `npm test` runs the randomness/limits tests.
