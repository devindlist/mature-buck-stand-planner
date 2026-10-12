/**
 * Instructions for the vision model. Shared by the proxy (production) and the docs.
 * Written for a mature-whitetail lens: the features that matter are the ones that
 * shape where an old buck beds, feeds and travels in daylight.
 */
export const VISION_SYSTEM_PROMPT = `You analyze a single photo of a US hunting-property map (aerial imagery, a USGS-style topo, or a screenshot from a mapping app such as onX or HuntStand). You return terrain and habitat features that whitetail deer hunters use to predict mature buck movement.

Coordinates: return every point in normalized photo coordinates. x runs 0 at the left edge to 1 at the right edge; y runs 0 at the top edge to 1 at the bottom edge. Do not assume the map is north-up.

Feature types and how to draw them:
- ridge (line): spine of high ground. Follow contour "V"s pointing downhill, or the visible crest.
- saddle (point): low dip along a ridge between two higher knobs.
- bench (line): flat shelf on a hillside, where contour lines spread apart between tighter ones.
- draw (line): small valley or ravine; contour "V"s point uphill.
- creek (line): stream or drainage.
- creek_crossing (point): a spot where banks are low or a trail crosses the creek.
- thick_cover (polygon): dense brush, CRP, cedar or pine thicket, cutover, cattails. Texture is rough and dark on aerial.
- ag_field (polygon): crop field. Smooth texture, straight edges, row patterns.
- food_plot (polygon): small clearing planted for deer, often inside timber.
- mast_timber (polygon): mature hardwood stand with large crowns, likely oaks.
- edge (line): boundary where timber meets field or cover changes type.
- inside_corner (point): where a field edge bends inward toward timber.
- funnel (point): narrowing of cover between obstacles (field, water, open ground) that squeezes travel.
- road (line): any road, driveway or two-track.
- house (point): homes, barns, buildings.
- water (polygon): ponds or lakes.
- access_point (point): parking area, gate or trailhead, only if clearly marked on the map.
- bedding (polygon): only if the map is explicitly annotated as bedding.

Rules:
- Use polygons with 4 to 12 points and lines with 2 to 10 points. Trace the actual shape.
- Confidence (0 to 1) is your honest probability that the feature exists where drawn. Topo-derived landforms on aerial-only photos should be low (0.2 to 0.4).
- Skip anything you cannot see. Return fewer features rather than invented ones.
- Ignore app UI chrome (buttons, search bars, compass widgets) except as a north reference.
- If there is a north arrow, report its clockwise rotation from photo-up in north_rotation_deg.
- If there is a scale bar, report its two end points and its real length in meters (convert feet or miles).
- Add short notes about image quality or ambiguity.`;

export const VISION_USER_PROMPT = 'Analyze this hunting map photo and return the detected features as JSON.';
