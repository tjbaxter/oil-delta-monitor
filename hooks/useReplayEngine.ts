"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Observation, ReplayPayload } from "@/lib/types";

export type ReplaySpeed = 1 | 2 | 5 | 10 | 20;

export interface ReplayEngineState {
  visibleObservations: Observation[];
  currentIndex: number;
  totalCount: number;
  isPlaying: boolean;
  speed: ReplaySpeed;
  progress: number;
  currentTimestamp: number | null;
  play: () => void;
  pause: () => void;
  seek: (index: number) => void;
  setSpeed: (speed: ReplaySpeed) => void;
  restart: () => void;
}

const MAX_DELAY_MS = 3_000;
const MIN_DELAY_MS = 50;

export function useReplayEngine(
  sessionData: ReplayPayload | null,
  initialSpeed: ReplaySpeed = 5
): ReplayEngineState {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(initialSpeed);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allObservations = sessionData?.observations ?? [];
  const totalCount = allObservations.length;

  // Auto-start after data loads.
  // If the payload specifies an animationStartIndex, use that; otherwise default to 70%.
  useEffect(() => {
    if (sessionData && totalCount > 0) {
      const startIdx =
        sessionData.animationStartIndex !== null && sessionData.animationStartIndex !== undefined
          ? Math.min(sessionData.animationStartIndex, totalCount - 1)
          : Math.floor(totalCount * 0.7);
      setCurrentIndex(startIdx);
      setIsPlaying(true);
    }
  }, [sessionData, totalCount]);

  // Clear any pending timer on unmount or when paused/index changes
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearTimer();

    if (!isPlaying || currentIndex >= totalCount - 1 || totalCount === 0) {
      return;
    }

    const current = allObservations[currentIndex];
    const next = allObservations[currentIndex + 1];

    if (!current || !next) {
      return;
    }

    const realGapMs = next.timestamp - current.timestamp;
    const scaledMs = realGapMs / speed;
    const delayMs = Math.min(Math.max(scaledMs, MIN_DELAY_MS), MAX_DELAY_MS);

    timerRef.current = setTimeout(() => {
      setCurrentIndex((prev) => Math.min(prev + 1, totalCount - 1));
    }, delayMs);

    return clearTimer;
  }, [currentIndex, isPlaying, totalCount, speed, allObservations, clearTimer]);

  const visibleObservations = useMemo(
    () => allObservations.slice(0, currentIndex + 1),
    [allObservations, currentIndex]
  );

  const currentTimestamp = allObservations[currentIndex]?.timestamp ?? null;
  const progress = totalCount > 1 ? currentIndex / (totalCount - 1) : 0;

  const play = useCallback(() => setIsPlaying(true), []);
  const pause = useCallback(() => setIsPlaying(false), []);
  const seek = useCallback((index: number) => {
    setCurrentIndex(Math.max(0, Math.min(index, totalCount - 1)));
  }, [totalCount]);
  const restart = useCallback(() => {
    setCurrentIndex(0);
    setIsPlaying(true);
  }, []);

  return {
    visibleObservations,
    currentIndex,
    totalCount,
    isPlaying,
    speed,
    progress,
    currentTimestamp,
    play,
    pause,
    seek,
    setSpeed,
    restart
  };
}
