import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoRouter from 'expo-router';
import { router } from 'expo-router';
import { compass16, downwindBearing, type WeatherSnapshot } from '@msp/engine';
import { useAppStore } from '../state/store';
import { useForecastFreshness } from '../state/useForecast';
import { getPlan } from '../db/repos';
import { useTheme } from '../theme/ThemeContext';
import { WindArrow, LowConfidenceTag } from './Icons';
import { badgeLabel, badgeScreen, draftBadgeWind, observedWindFresh, planBadgeWind, type BadgeWind } from '../services/windDisplay';
import { font, TOUCH } from '../theme/theme';

/** Width every screen header reserves on the right so the badge never moves. */
export const WIND_BADGE_RESERVED = 112;

/** The route path (e.g. '/hunt'), via the one expo-router hook we need, typed here on its own. */
const usePathname = (ExpoRouter as unknown as { usePathname(): string }).usePathname;

/**
 * The weather of the plan a hunt belongs to. Normally that is the plan in memory; after a
 * restart, or when a newer plan has been made since, it is read from the database once.
 * `undefined` while it loads or when it cannot be found.
 */
function useHuntPlanWeather(planId: string | undefined, storePlanId: string | undefined, storeWeather: WeatherSnapshot | undefined): WeatherSnapshot | undefined {
  const [loaded, setLoaded] = useState<{ id: string; weather?: WeatherSnapshot } | null>(null);
  const needsLoad = !!planId && planId !== storePlanId;
  useEffect(() => {
    if (!needsLoad || !planId) return;
    let alive = true;
    getPlan(planId)
      .then((p) => alive && setLoaded({ id: planId, weather: p?.plan.inputs.weather }))
      .catch(() => alive && setLoaded({ id: planId }));
    return () => {
      alive = false;
    };
  }, [needsLoad, planId]);
  if (!planId) return storeWeather;
  return planId === storePlanId ? storeWeather : loaded?.id === planId ? loaded.weather : undefined;
}

/**
 * The wind arrow lives in the SAME spot on every screen (top-right), rendered once
 * by the root layout above all screens. The arrow points where scent goes.
 *
 * It never presents a guess as a forecast: with no forecast and nothing confirmed it shows
 * "Wind ?" (defaults), and while the stored forecast belongs to another sit or is still
 * loading it is dimmed and says so. Hunter entries are marked with a dot. Results, the plan
 * card and Hunt mode show the wind the PLAN was made with (Hunt: your wind at the tree while it
 * is fresh); every other screen shows the draft's sit. See services/windDisplay.ts.
 */
export function WindBadge() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const screen = badgeScreen(pathname);
  const weather = useAppStore((s) => s.weather);
  const overrides = useAppStore((s) => s.draft.overrides);
  const storePlan = useAppStore((s) => s.plan);
  const hunt = useAppStore((s) => s.hunt);
  const fresh = useForecastFreshness();
  const huntWeather = useHuntPlanWeather(screen === 'hunt' ? hunt?.planId : undefined, storePlan?.plan.id, storePlan?.plan.inputs.weather);

  // A wind the hunter tapped at the tree goes stale after a while: re-check once a minute on Hunt.
  const [now, setNow] = useState(Date.now());
  const watchObserved = screen === 'hunt' && !!hunt?.observedWindAt;
  useEffect(() => {
    if (!watchObserved) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [watchObserved, hunt?.observedWindAt]);

  let wind: BadgeWind;
  if (screen === 'draft') {
    wind = draftBadgeWind(weather, overrides, fresh);
  } else {
    const observed = screen === 'hunt' && hunt?.observedWindFromDeg !== undefined && observedWindFresh(hunt.observedWindAt, now) ? { fromDeg: hunt.observedWindFromDeg } : undefined;
    wind = planBadgeWind(screen === 'hunt' && hunt ? huntWeather : storePlan?.plan.inputs.weather, observed);
  }

  const dim = wind.kind === 'wind' && !!wind.stale;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 6, right: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={badgeLabel(wind)}
        accessibilityHint="Opens wind settings"
        onPress={() => {
          // Already on Plan Hunt: nothing to open (a second copy would stack on the first).
          if ((pathname ?? '').split('?')[0].replace(/\/+$/, '') !== '/plan') router.push('/plan');
        }}
        style={{
          minWidth: 96,
          minHeight: TOUCH,
          borderRadius: 14,
          borderWidth: wind.kind === 'defaults' ? 1.5 : 1,
          borderStyle: wind.kind === 'defaults' ? 'dashed' : 'solid',
          borderColor: wind.kind === 'defaults' ? t.status.caution : t.border,
          backgroundColor: t.surface,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 8,
          opacity: dim ? 0.55 : 1,
        }}
      >
        {wind.kind === 'wind' ? (
          <>
            <WindArrow downwindDeg={downwindBearing(wind.fromDeg)} color={t.wind} size={32} />
            <View style={{ marginLeft: 4 }}>
              <Text style={{ color: t.text, fontWeight: '800', fontSize: font.md }}>{compass16(wind.fromDeg)}</Text>
              <Text numberOfLines={1} style={{ color: t.textDim, fontSize: font.xs }}>
                {wind.stale === 'loading'
                  ? 'loading…'
                  : wind.stale === 'other_sit'
                    ? 'other sit'
                    : wind.from === 'observed'
                      ? 'your wind •'
                      : `${wind.speedMph === undefined ? '?' : Math.round(wind.speedMph)} mph${wind.own ? ' •' : ''}`}
              </Text>
            </View>
          </>
        ) : (
          <>
            <LowConfidenceTag color={wind.kind === 'defaults' ? t.status.caution : t.textDim} size={28} />
            <View style={{ marginLeft: 6 }}>
              <Text style={{ color: wind.kind === 'defaults' ? t.text : t.textDim, fontWeight: '800', fontSize: font.sm }}>{wind.kind === 'defaults' ? 'Wind ?' : 'No wind'}</Text>
              <Text numberOfLines={1} style={{ color: t.textDim, fontSize: font.xs }}>
                {wind.kind === 'defaults' ? (wind.loading ? 'loading…' : 'defaults') : 'not set'}
              </Text>
            </View>
          </>
        )}
      </Pressable>
    </View>
  );
}
