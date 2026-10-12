/**
 * Core data models for Mature Buck Stand Planner.
 *
 * Coordinate conventions used everywhere in the engine:
 *  - `Vec` is a point in a property-local planar frame, in METERS.
 *    x = east, y = north. Origin is the calibration origin (reference point 1,
 *    or the photo center when the photo is not geo-referenced).
 *  - Bearings are degrees clockwise from true north, 0..360.
 *  - Wind is always reported meteorologically: `windFromDeg` is the direction
 *    the wind blows FROM. Scent travels toward windFromDeg + 180.
 *  - Times are ISO-8601 strings in UTC; the UI formats them in local time.
 *
 * The models are plain JSON-serializable objects so they can be stored as-is in
 * SQLite JSON columns and shipped across the vision proxy boundary.
 */

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // full ISO-8601 timestamp, UTC

export interface LatLon {
  lat: number;
  lon: number;
}

/** Local planar point in meters (x = east, y = north). */
export interface Vec {
  x: number;
  y: number;
}

/** Point on the source photo, in pixels (x right, y down). */
export interface PixelPoint {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Enumerations (string unions keep the engine runnable under Node type-stripping)
// ---------------------------------------------------------------------------

export type SeasonPhase =
  | 'early_season'
  | 'october_lull'
  | 'pre_rut'
  | 'seeking_chasing'
  | 'lockdown'
  | 'post_rut'
  | 'late_season';

export const SEASON_PHASES: readonly SeasonPhase[] = [
  'early_season',
  'october_lull',
  'pre_rut',
  'seeking_chasing',
  'lockdown',
  'post_rut',
  'late_season',
];

export type HuntWindow = 'AM' | 'PM';

export type WeaponType = 'bow' | 'crossbow' | 'muzzleloader' | 'shotgun' | 'rifle' | 'handgun';

export interface Weapon {
  type: WeaponType;
  /** The hunter's own ethical effective range. Never exceeded by the shot plan. */
  effectiveRangeYds: number;
}

export type FeatureType =
  | 'ridge'
  | 'saddle'
  | 'bench'
  | 'draw'
  | 'creek'
  | 'creek_crossing'
  | 'thick_cover'
  | 'ag_field'
  | 'food_plot'
  | 'mast_timber'
  | 'edge'
  | 'inside_corner'
  | 'funnel'
  | 'road'
  | 'house'
  | 'water'
  | 'bedding'
  | 'access_point';

export const FEATURE_TYPES: readonly FeatureType[] = [
  'ridge',
  'saddle',
  'bench',
  'draw',
  'creek',
  'creek_crossing',
  'thick_cover',
  'ag_field',
  'food_plot',
  'mast_timber',
  'edge',
  'inside_corner',
  'funnel',
  'road',
  'house',
  'water',
  'bedding',
  'access_point',
];

export type GeometryKind = 'point' | 'line' | 'polygon';

export interface Geometry {
  kind: GeometryKind;
  /** Local meters. point: 1 vertex, line: >= 2, polygon: >= 3 (implicitly closed). */
  points: Vec[];
}

export type FeatureSource = 'vision' | 'user' | 'elevation' | 'landcover' | 'inferred';

export type CropType =
  /** Crop known, stage not: resolved by date/phase at plan time (e.g. from USDA CDL). */
  | 'corn'
  | 'soybeans'
  | 'corn_standing'
  | 'corn_picked'
  | 'soybeans_green'
  | 'soybeans_standing'
  | 'soybeans_cut'
  | 'alfalfa_clover'
  | 'winter_wheat'
  | 'brassicas'
  | 'unknown';

export interface MapFeature {
  id: string;
  type: FeatureType;
  geometry: Geometry;
  /** 0..1. User-placed features default to 1. */
  confidence: number;
  source: FeatureSource;
  /** 'dismissed' features are kept for undo but ignored by the engine. */
  status: 'active' | 'dismissed';
  label?: string;
  rationale?: string;
  userEdited?: boolean;
  attributes?: {
    crop?: CropType;
    /** For bedding the hunter marked: whose bedding it is. */
    beddingKind?: 'buck' | 'doe' | 'unknown';
    /** Cross-check notes from USGS 3DEP / NLCD / CDL. */
    crossCheck?: CrossCheckNote[];
  };
}

export interface CrossCheckNote {
  source: '3DEP' | 'NLCD' | 'CDL';
  agrees: boolean | null;
  detail: string;
  confidenceDelta: number;
}

// ---------------------------------------------------------------------------
// Map photo calibration
// ---------------------------------------------------------------------------

export interface ReferencePoint {
  pixel: PixelPoint;
  /** Known coordinates (typed in, from GPS, or picked on the basemap). */
  geo?: LatLon;
  label?: string;
}

export interface Calibration {
  imageWidth: number;
  imageHeight: number;
  /**
   * Clockwise rotation (degrees) from "up" on the photo to true north.
   * 0 = photo is north-up. 90 = north points to the right edge of the photo.
   */
  northRotationDeg: number;
  metersPerPixel: number;
  /** Pixel that maps to local (0,0). */
  originPixel: PixelPoint;
  /** Lat/lon of the origin pixel, when known. Enables NWS, 3DEP, NLCD and basemap overlay. */
  originGeo?: LatLon;
  referencePoints: ReferencePoint[];
  method: 'north_and_scale' | 'two_point_geo';
  /** Warnings produced while solving (e.g. north arrow disagrees with reference points). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Property, stands, cameras
// ---------------------------------------------------------------------------

export type StandType = 'hang_on' | 'ladder' | 'climber' | 'saddle' | 'box_blind' | 'ground_blind';

export interface Stand {
  id: string;
  propertyId: string;
  name: string;
  position: Vec;
  /** existing = the hunter's own stand; generated = proposed by the engine. */
  origin: 'existing' | 'generated';
  type: StandType;
  heightFt?: number;
  /** Hunter-entered preferred winds (FROM directions) — shown alongside engine output. */
  hunterPreferredWindsDeg?: number[];
  notes?: string;
  /** Hunter dismissed this stand for planning; engine will skip it. */
  dismissed?: boolean;
}

export interface Camera {
  id: string;
  propertyId: string;
  name: string;
  position: Vec;
  facingDeg?: number;
}

export interface AccessConstraint {
  id: string;
  kind: 'no_access_zone' | 'must_use_gate' | 'neighbor_line' | 'other';
  geometry: Geometry;
  note?: string;
}

export interface Property {
  id: string;
  name: string;
  /** Two-letter US state code. Used for rut calendar and regulation reminders. */
  stateCode: string;
  calibration?: Calibration;
  mapImageUri?: string;
  /** Local-meter polygon. Generated stands and routes stay inside it. */
  boundary?: Vec[];
  features: MapFeature[];
  stands: Stand[];
  cameras: Camera[];
  accessConstraints: AccessConstraint[];
  /** How the map's features were produced. 'mock' = demo detections, not from this photo. */
  analysisMode?: 'mock' | 'proxy' | 'manual';
  /** Spots where the hunter dismissed an engine-generated stand; never proposed again. */
  dismissedCandidatePositions?: Vec[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Observations & history
// ---------------------------------------------------------------------------

export type Maturity = 'mature_buck' | 'young_buck' | 'doe' | 'unknown';

export type SightingBehavior =
  | 'feeding'
  | 'traveling'
  | 'cruising'
  | 'chasing'
  | 'bedded'
  | 'scraping'
  | 'rubbing'
  | 'unknown';

export interface Sighting {
  id: string;
  propertyId: string;
  huntId?: string;
  at: ISODateTime;
  position?: Vec;
  maturity: Maturity;
  count: number;
  /** Direction of travel (bearing the deer was heading). */
  headingDeg?: number;
  behavior: SightingBehavior;
  source: 'observed' | 'trail_cam' | 'sign';
  cameraId?: string;
  photoUri?: string;
  notes?: string;
}

export interface PressureEvent {
  id: string;
  propertyId: string;
  at: ISODateTime;
  kind: 'sit' | 'walk_through' | 'bumped_deer' | 'neighbor_activity' | 'work_activity';
  standId?: string;
  position?: Vec;
  note?: string;
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

export type PrecipType = 'none' | 'rain' | 'snow' | 'sleet' | 'freezing_rain' | 'thunderstorm';
export type PressureTrend = 'rising' | 'falling' | 'steady' | 'unknown';

export interface HourlyWind {
  at: ISODateTime;
  windFromDeg: number;
  windSpeedMph: number;
  windGustMph?: number;
  tempF?: number;
}

export interface WeatherSnapshot {
  id: string;
  at: ISODateTime;
  source: 'nws' | 'manual' | 'mixed';
  windFromDeg: number;
  windSpeedMph: number;
  windGustMph: number;
  tempF: number;
  cloudCoverPct?: number;
  precipChancePct?: number;
  precipType: PrecipType;
  pressureHpa?: number;
  pressureTrend: PressureTrend;
  pressureChange3hHpa?: number;
  windChillF?: number;
  /** Forecast through the sit window — used for wind-shift risk. */
  hourly?: HourlyWind[];
  /** Field names the hunter overrode by hand. Manual values always win. */
  overriddenFields: string[];
  /** True when no forecast was available and values are defaults the hunter has not confirmed. */
  placeholder?: boolean;
  shortForecast?: string;
}

// ---------------------------------------------------------------------------
// Hunts
// ---------------------------------------------------------------------------

export type HuntOutcome =
  | 'no_deer'
  | 'does_only'
  | 'young_bucks'
  | 'mature_buck_seen'
  | 'mature_buck_harvested'
  | 'bumped_deer'
  | 'aborted';

export interface Hunt {
  id: string;
  propertyId: string;
  planId?: string;
  standId?: string;
  date: ISODate;
  window: HuntWindow;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
  weatherSnapshotId?: string;
  outcome?: HuntOutcome;
  /** Did the hunter actually use the planned entry/exit? Feeds pressure history. */
  usedPlannedEntry?: boolean;
  usedPlannedExit?: boolean;
  bumpedDeerOnEntry?: boolean;
  bumpedDeerOnExit?: boolean;
  notes?: string;
  checkIn?: {
    expectedBackAt: ISODateTime;
    emergencyContactName?: string;
    emergencyContactPhone?: string;
    status: 'armed' | 'checked_in' | 'overdue' | 'cancelled';
  };
}

// ---------------------------------------------------------------------------
// Planning I/O
// ---------------------------------------------------------------------------

export interface PlanInputs {
  propertyId: string;
  date: ISODate;
  window: HuntWindow;
  /** Where the sun/legal-hours math is done. Usually the property's origin. */
  location: LatLon;
  weather: WeatherSnapshot;
  weapon: Weapon;
  phaseOverride?: SeasonPhase;
  /** Overrides the phase-default setback from buck bedding, meters. */
  beddingSetbackOverrideM?: number;
}

export type Status = 'safe' | 'caution' | 'avoid';

export interface ScoreComponent {
  key:
    | 'windFit'
    | 'accessStealth'
    | 'movementLikelihood'
    | 'beddingDistance'
    | 'shotOpportunity'
    | 'cover'
    | 'pressureHistory'
    | 'weatherTimeFit';
  label: string;
  max: number;
  value: number;
  /** Plain-language "why" lines shown when the hunter taps the score. */
  reasons: string[];
  /** e.g. 'low_confidence' for moon / pressure-trend modifiers. */
  tags: ModifierTag[];
}

export type ModifierTag = 'low_confidence' | 'observed_data' | 'user_override';

export interface ScoreBreakdown {
  total: number;
  components: ScoreComponent[];
}

export interface RouteSegment {
  /** Polyline for this stretch (>= 2 points). Consecutive stretches share end points. */
  points: Vec[];
  status: Status;
  reason: string;
}

export interface Route {
  kind: 'entry' | 'exit';
  startLabel: string;
  points: Vec[];
  segments: RouteSegment[];
  lengthM: number;
  minDistToBeddingM: number;
  /** Fraction of points that overlap the other route (entry vs exit). */
  overlapWithOther?: number;
  notes: string[];
  worstStatus: Status;
}

export interface ShotLane {
  fromDeg: number;
  toDeg: number;
  status: 'open' | 'no_shot';
  maxYds: number;
  reason: string;
}

export interface ShotPlan {
  effectiveRangeYds: number;
  expectedShotYds: number | null;
  primaryBearingDeg: number | null;
  lanes: ShotLane[];
  notes: string[];
}

export interface WindDialSector {
  /** Center bearing (FROM) of a 22.5° sector. */
  fromDeg: number;
  status: 'good' | 'caution' | 'bad';
}

export interface WindDial {
  sectors: WindDialSector[];
  currentFromDeg: number;
}

export interface Risk {
  severity: 1 | 2 | 3;
  text: string;
}

export interface Confidence {
  value: number;
  level: 'high' | 'medium' | 'low';
  factors: string[];
}

export interface Decision {
  status: 'go' | 'caution' | 'no_go';
  reasons: string[];
}

export interface SitWindow {
  start: ISODateTime;
  end: ISODateTime;
  label: string;
}

export interface StandRecommendation {
  stand: Stand;
  rank: number;
  isBackup: boolean;
  backupNote?: string;
  score: ScoreBreakdown;
  reason: string;
  sitWindow: SitWindow;
  windDial: WindDial;
  entryRoute: Route | null;
  exitRoute: Route | null;
  shotPlan: ShotPlan;
  risks: Risk[];
  confidence: Confidence;
  decision: Decision;
  safetyReminders: string[];
  /** Scent plumes at this stand for the map (wind and, in light wind, thermals). */
  plumes: Array<{ kind: 'wind' | 'thermal_falling' | 'thermal_rising' | 'swirl'; bearingDeg: number; halfAngleDeg: number; lengthM: number }>;
  /**
   * Set only on a wind-shift fallback backup: the hypothetical wind (FROM, degrees) this
   * recommendation was evaluated for. UI must label the dial/plume as "if wind is X".
   */
  assumedWindFromDeg?: number;
}

export interface EliminatedStand {
  stand: Stand;
  reasons: string[];
}

export interface Modifier {
  key: 'moon' | 'pressure_trend';
  label: string;
  detail: string;
  tag: 'low_confidence';
  /** Points applied inside weatherTimeFit (already damped when observed data exists). */
  points: number;
}

export interface PlanWarning {
  level: 'info' | 'caution' | 'no_go';
  text: string;
}

export interface SunTimes {
  sunrise: ISODateTime;
  sunset: ISODateTime;
  solarNoon: ISODateTime;
}

export interface LegalHours {
  start: ISODateTime;
  end: ISODateTime;
  rule: string;
}

export interface PhaseResult {
  phase: SeasonPhase;
  source: 'calendar' | 'user';
  label: string;
  regionTuned: boolean;
  note: string;
}

export interface HabitatSummary {
  bedding: BeddingArea[];
  food: FoodSource[];
  corridors: Corridor[];
}

export interface BeddingArea {
  id: string;
  label: string;
  center: Vec;
  /** Polygon if derived from a polygon feature; otherwise circle of radiusM. */
  polygon?: Vec[];
  radiusM: number;
  probability: number;
  kind: 'buck' | 'doe' | 'unknown';
  featureIds: string[];
  reasons: string[];
}

export interface FoodSource {
  id: string;
  label: string;
  center: Vec;
  polygon?: Vec[];
  radiusM: number;
  probability: number;
  kind: 'ag' | 'mast' | 'food_plot';
  featureIds: string[];
  reasons: string[];
}

export type CorridorKind = 'bed_to_food' | 'bed_to_bed' | 'cruise' | 'terrain_travel';

export interface PinchPoint {
  position: Vec;
  featureId: string;
  type: FeatureType;
}

export interface Corridor {
  id: string;
  kind: CorridorKind;
  /** Human label, e.g. "Timber edge" or "Ridge thicket → Bean field". */
  label: string;
  fromLabel?: string;
  toLabel?: string;
  /** Ordered from the deer's daytime-cover end (bedding) toward the other end. */
  points: Vec[];
  fromId?: string;
  toId?: string;
  strength: number;
  pinchPoints: PinchPoint[];
  reasons: string[];
}

export interface Plan {
  id: string;
  propertyId: string;
  createdAt: ISODateTime;
  engineVersion: string;
  inputs: PlanInputs;
  phase: PhaseResult;
  sun: SunTimes;
  legal: LegalHours;
  habitat: HabitatSummary;
  recommendations: StandRecommendation[];
  backup: StandRecommendation | null;
  /** The hunter's own stands that passed the gate but aren't in the top 3 / backup. Always shown. */
  yourStands: StandRecommendation[];
  eliminated: EliminatedStand[];
  warnings: PlanWarning[];
  modifiers: Modifier[];
  weatherDecision: Decision;
  reminders: string[];
  disclaimer: string;
}
