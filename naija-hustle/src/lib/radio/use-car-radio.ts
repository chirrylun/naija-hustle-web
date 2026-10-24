"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CarRadio,
  type CarRadioOptions,
  type CarRef,
  type NowPlaying,
  type RadioStation,
} from "./car-radio";

/**
 * Loads one page of Nigerian stations through our own server route (the API
 * key never reaches the browser). This is the first 100 stations only, not the
 * whole catalogue; more pages are available via `?offset=<pagination.nextOffset>`.
 */
export async function fetchStationsFromApi(): Promise<RadioStation[]> {
  const response = await fetch("/api/radio-stations");
  if (!response.ok) throw new Error("Could not load radio stations");
  const { data } = (await response.json()) as { data: RadioStation[] };
  return Array.isArray(data) ? data : [];
}

type UseCarRadioOptions = Omit<
  CarRadioOptions,
  "fetchStations" | "hasUserActivation" | "httpsOnly"
>;

/**
 * Ambient car radios. Call `onLightTransition({ id, proximity })` from the
 * scene whenever a car is at a light change. `nowPlaying` lists which cars
 * currently have a station on, e.g. to show a small "♪ Station name" bubble.
 */
export function useCarRadio(options: UseCarRadioOptions = {}) {
  const [nowPlaying, setNowPlaying] = useState<NowPlaying[]>([]);
  const radioRef = useRef<CarRadio | null>(null);
  // Options are read once; changing them later doesn't affect a running scene.
  const [initialOptions] = useState(options);

  useEffect(() => {
    // Browsers only allow audio after the visitor has interacted with the page.
    let activated = false;
    const markActive = () => {
      activated = true;
    };
    window.addEventListener("pointerdown", markActive, { once: true });
    window.addEventListener("keydown", markActive, { once: true });

    // Created inside the effect so React StrictMode's mount/unmount/mount in
    // development gets a fresh controller instead of a disposed one.
    const radio = new CarRadio({
      ...initialOptions,
      fetchStations: fetchStationsFromApi,
      httpsOnly: window.location.protocol === "https:",
      hasUserActivation: () =>
        activated || navigator.userActivation?.hasBeenActive === true,
    });
    radioRef.current = radio;
    const unsubscribe = radio.subscribe(setNowPlaying);

    return () => {
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      unsubscribe();
      radio.dispose();
      radioRef.current = null;
      setNowPlaying([]);
    };
  }, [initialOptions]);

  const onLightTransition = useCallback((car: CarRef) => {
    radioRef.current?.onLightTransition(car);
  }, []);
  const stopCar = useCallback((carId: string) => {
    radioRef.current?.stopCar(carId);
  }, []);

  return useMemo(
    () => ({ onLightTransition, stopCar, nowPlaying }),
    [onLightTransition, stopCar, nowPlaying],
  );
}
