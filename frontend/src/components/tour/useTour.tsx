import { useCallback, useEffect, useRef } from 'react';
import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useT } from '../../i18n/hooks';

export interface TourStep {
  element: string;
  titleKey: string;
  contentKey: string;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
}
interface UseTourOptions {
  steps: TourStep[];
  onComplete?: () => void;
  onSkip?: () => void;
}

export const useTour = ({ steps, onComplete, onSkip }: UseTourOptions) => {
  const t = useT();
  const driverRef = useRef<ReturnType<typeof driver> | null>(null);
  const callbacks = useRef({ onComplete, onSkip });
  callbacks.current = { onComplete, onSkip };
  const startRef = useRef<() => void>(() => {});
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    let reason: 'complete' | 'skip' | 'cleanup' | undefined;
    let notified = false;
    const finish = (nextReason: 'complete' | 'skip' | 'cleanup') => {
      reason = nextReason;
      instance.destroy();
    };
    const driveSteps: DriveStep[] = steps.map(step => ({
      element: step.placement === 'center' ? undefined : step.element,
      popover: {
        title: t(step.titleKey),
        description: t(step.contentKey),
        side: step.placement === 'center' ? undefined : step.placement ?? 'bottom',
        align: 'start',
      },
    }));
    const instance = driver({
      steps: driveSteps,
      showProgress: true,
      showButtons: ['next', 'previous', 'close'],
      progressText: '{{current}}/{{total}}',
      nextBtnText: t('components.tour.nextBtn'),
      prevBtnText: t('components.tour.prevBtn'),
      doneBtnText: t('components.tour.doneBtn'),
      animate: true,
      overlayOpacity: 0.7,
      smoothScroll: true,
      allowClose: true,
      overlayColor: '#000',
      stagePadding: 8,
      stageRadius: 8,
      popoverClass: 'tour-popover',
      onDestroyStarted: () => finish('skip'),
      onDestroyed: () => {
        if (notified || reason === 'cleanup') return;
        notified = true;
        if (reason === 'complete') callbacks.current.onComplete?.();
        else callbacks.current.onSkip?.();
      },
      onNextClick: () => {
        if (instance.getActiveIndex() === steps.length - 1) finish('complete');
        else instance.moveNext();
      },
    });
    driverRef.current = instance;
    stopRef.current = () => finish('skip');
    startRef.current = () => { reason = undefined; notified = false; instance.drive(); };
    return () => {
      finish('cleanup');
      if (driverRef.current === instance) driverRef.current = null;
    };
  }, [steps, t]);

  const startTour = useCallback(() => startRef.current(), []);
  const stopTour = useCallback(() => stopRef.current(), []);
  return { startTour, stopTour };
};
