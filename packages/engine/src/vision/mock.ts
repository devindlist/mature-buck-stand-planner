import type { VisionResult } from './schema.ts';

/**
 * Deterministic mock analysis: a typical Midwest farm with an E–W oak ridge,
 * a saddle, a bench thicket (buck bedding), a doe thicket near an L-shaped bean
 * field, a creek with a crossing, a county road and a house.
 *
 * Used for offline demos, UI development and engine tests. The UI always labels
 * these results as "Mock analysis".
 */
export const MOCK_VISION_RESULT: VisionResult = {
  map_type: 'aerial',
  north_arrow_detected: false,
  north_rotation_deg: 0,
  scale_bar_detected: false,
  scale_bar_meters: 0,
  scale_bar_points: [],
  notes: ['Mock analysis. Detections are illustrative, not from your photo.'],
  features: [
    { type: 'road', geometry_kind: 'line', points: [{ x: 0, y: 0.96 }, { x: 1, y: 0.96 }], confidence: 0.95, label: 'County road', rationale: 'Gravel road along the south line.' },
    { type: 'house', geometry_kind: 'point', points: [{ x: 0.08, y: 0.9 }], confidence: 0.9, label: 'Farmhouse', rationale: 'Buildings and yard.' },
    { type: 'access_point', geometry_kind: 'point', points: [{ x: 0.62, y: 0.94 }], confidence: 0.8, label: 'Field gate', rationale: 'Gate and pull-off on the road.' },
    {
      type: 'ag_field',
      geometry_kind: 'polygon',
      points: [
        { x: 0.35, y: 0.62 },
        { x: 0.7, y: 0.62 },
        { x: 0.7, y: 0.5 },
        { x: 0.95, y: 0.5 },
        { x: 0.95, y: 0.9 },
        { x: 0.35, y: 0.9 },
      ],
      confidence: 0.92,
      label: 'Bean field',
      rationale: 'Uniform row texture with straight edges.',
    },
    { type: 'inside_corner', geometry_kind: 'point', points: [{ x: 0.7, y: 0.62 }], confidence: 0.75, label: 'Inside corner', rationale: 'Field edge turns in toward the timber.' },
    {
      type: 'edge',
      geometry_kind: 'line',
      points: [
        { x: 0.35, y: 0.62 },
        { x: 0.7, y: 0.62 },
        { x: 0.7, y: 0.5 },
        { x: 0.95, y: 0.5 },
      ],
      confidence: 0.85,
      label: 'Timber edge',
      rationale: 'Where the hardwoods meet the field.',
    },
    {
      type: 'ridge',
      geometry_kind: 'line',
      points: [
        { x: 0.05, y: 0.22 },
        { x: 0.3, y: 0.18 },
        { x: 0.55, y: 0.21 },
        { x: 0.8, y: 0.17 },
        { x: 0.98, y: 0.2 },
      ],
      confidence: 0.6,
      label: 'Main ridge',
      rationale: 'Crest line from shadowing and tree height.',
    },
    { type: 'saddle', geometry_kind: 'point', points: [{ x: 0.55, y: 0.21 }], confidence: 0.55, label: 'Saddle', rationale: 'Dip in the ridge between two knobs.' },
    {
      type: 'bench',
      geometry_kind: 'line',
      points: [
        { x: 0.72, y: 0.3 },
        { x: 0.88, y: 0.28 },
      ],
      confidence: 0.45,
      label: 'Bench',
      rationale: 'Flat shelf below the ridge on the south face.',
    },
    {
      type: 'thick_cover',
      geometry_kind: 'polygon',
      points: [
        { x: 0.72, y: 0.22 },
        { x: 0.92, y: 0.22 },
        { x: 0.92, y: 0.38 },
        { x: 0.72, y: 0.38 },
      ],
      confidence: 0.8,
      label: 'Ridge thicket',
      rationale: 'Dense regrowth, rough dark texture.',
    },
    {
      type: 'thick_cover',
      geometry_kind: 'polygon',
      points: [
        { x: 0.1, y: 0.45 },
        { x: 0.28, y: 0.45 },
        { x: 0.28, y: 0.6 },
        { x: 0.1, y: 0.6 },
      ],
      confidence: 0.75,
      label: 'Cedar thicket',
      rationale: 'Evergreen thicket close to the field.',
    },
    {
      type: 'mast_timber',
      geometry_kind: 'polygon',
      points: [
        { x: 0.4, y: 0.3 },
        { x: 0.62, y: 0.3 },
        { x: 0.62, y: 0.46 },
        { x: 0.4, y: 0.46 },
      ],
      confidence: 0.6,
      label: 'Oak flat',
      rationale: 'Large rounded crowns typical of mature oaks.',
    },
    {
      type: 'creek',
      geometry_kind: 'line',
      points: [
        { x: 0.0, y: 0.7 },
        { x: 0.15, y: 0.68 },
        { x: 0.3, y: 0.72 },
        { x: 0.34, y: 0.82 },
        { x: 0.33, y: 0.96 },
      ],
      confidence: 0.85,
      label: 'Creek',
      rationale: 'Tree-lined drainage.',
    },
    { type: 'creek_crossing', geometry_kind: 'point', points: [{ x: 0.15, y: 0.68 }], confidence: 0.5, label: 'Crossing', rationale: 'Low banks and a visible trail.' },
    { type: 'funnel', geometry_kind: 'point', points: [{ x: 0.32, y: 0.52 }], confidence: 0.55, label: 'Funnel', rationale: 'Timber pinches between the cedar thicket and the field.' },
    {
      type: 'water',
      geometry_kind: 'polygon',
      points: [
        { x: 0.2, y: 0.84 },
        { x: 0.27, y: 0.84 },
        { x: 0.27, y: 0.9 },
        { x: 0.2, y: 0.9 },
      ],
      confidence: 0.9,
      label: 'Pond',
      rationale: 'Open water.',
    },
  ],
};
