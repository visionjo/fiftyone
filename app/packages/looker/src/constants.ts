/**
 * Copyright 2017-2022, Voxel51, Inc.
 */

export const BASE_ALPHA = 0.7;
export const LINE_WIDTH = 3;
export const DASH_LENGTH = 8;
export const INFO_COLOR = "#ffffff";
export const PAD = 4;
export const TOLERANCE = 1.15;
export const POINT_RADIUS = 4;
export const RADIUS = 12;
export const STROKE_WIDTH = 3;
export const FONT_SIZE = 16;
export const MIN_PIXELS = 16;
export const SCALE_FACTOR = 1.09;
export const MAX_FRAME_CACHE_SIZE_BYTES = 1e9;
export const CHUNK_SIZE = 20;
export const DATE_TIME = "DateTime";

export const NONFINITES = new Set(["-inf", "inf", "nan"]);

export const CLASSIFICATION = "Classification";
export const CLASSIFICATIONS = "Classifications";
export const DETECTION = "Detection";
export const DETECTIONS = "Detections";
export const GEOLOCATION = "GeoLocation";
export const GEOLOCATIONS = "GeoLocations";
export const HEATMAP = "Heatmap";
export const KEYPOINT = "Keypoint";
export const KEYPOINTS = "Keypoints";
export const POLYLINE = "Polyline";
export const POLYLINES = "Polylines";
export const REGRESSION = "Regression";
export const SEGMENTATION = "Segmentation";
export const TEMPORAL_DETECTION = "TemporalDetection";
export const TEMPORAL_DETECTIONS = "TemporalDetections";

export const BOOLEAN_FIELD = "fiftyone.core.fields.BooleanField";
export const DATE_FIELD = "fiftyone.core.fields.DateField";
export const DATE_TIME_FIELD = "fiftyone.core.fields.DateTimeField";
export const FLOAT_FIELD = "fiftyone.core.fields.FloatField";
export const FRAME_NUMBER_FIELD = "fiftyone.core.fields.FrameNumberField";
export const FRAME_SUPPORT_FIELD = "fiftyone.core.fields.FrameSupportField";
export const INT_FIELD = "fiftyone.core.fields.IntField";
export const OBJECT_ID_FIELD = "fiftyone.core.fields.ObjectIdField";
export const STRING_FIELD = "fiftyone.core.fields.StringField";

export const MOMENT_CLASSIFICATIONS = [
  CLASSIFICATION,
  CLASSIFICATIONS,
  REGRESSION,
];

export const LABEL_TAGS_CLASSES = [
  CLASSIFICATION,
  CLASSIFICATIONS,
  REGRESSION,
  TEMPORAL_DETECTION,
  TEMPORAL_DETECTIONS,
];

export const LABEL_LISTS = {
  [CLASSIFICATIONS]: "classifications",
  [DETECTIONS]: "detections",
  [KEYPOINTS]: "Keypoints",
  [POLYLINES]: "polylines",
  [TEMPORAL_DETECTIONS]: "detections",
};

export const LABELS = {
  [CLASSIFICATION]: CLASSIFICATION,
  [CLASSIFICATIONS]: CLASSIFICATIONS,
  [DETECTION]: DETECTION,
  [DETECTIONS]: DETECTIONS,
  [GEOLOCATION]: GEOLOCATION,
  [GEOLOCATIONS]: GEOLOCATIONS,
  [HEATMAP]: HEATMAP,
  [KEYPOINT]: KEYPOINT,
  [KEYPOINTS]: KEYPOINTS,
  [POLYLINE]: POLYLINE,
  [POLYLINES]: POLYLINES,
  [SEGMENTATION]: SEGMENTATION,
  [REGRESSION]: REGRESSION,
  [TEMPORAL_DETECTION]: TEMPORAL_DETECTION,
  [TEMPORAL_DETECTIONS]: TEMPORAL_DETECTIONS,
};

export const MASK_LABELS = new Set([DETECTION, SEGMENTATION]);

export const SELECTION_TEXT =
  "Click to select sample, Shift+Click to select a range";

export const JSON_COLORS = {
  keyColor: "rgb(138, 138, 138)",
  numberColor: "rgb(225, 100, 40)",
  stringColor: "rgb(238, 238, 238)",
  nullColor: "rgb(225, 100, 40)",
  trueColor: "rgb(225, 100, 40)",
  falseColor: "rgb(225, 100, 40)",
};

export const BIG_ENDIAN = (() => {
  let buf = new ArrayBuffer(4);
  let u32data = new Uint32Array(buf);
  let u8data = new Uint8Array(buf);
  u32data[0] = 0xcafebabe;
  return u8data[0] === 0xca;
})();
