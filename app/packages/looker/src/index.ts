/**
 * Copyright 2017-2022, Voxel51, Inc.
 */
import LRU from "lru-cache";
import { v4 as uuid } from "uuid";
import highlightJSON from "json-format-highlight";
import copyToClipboard from "copy-to-clipboard";

import {
  FONT_SIZE,
  STROKE_WIDTH,
  PAD,
  POINT_RADIUS,
  MAX_FRAME_CACHE_SIZE_BYTES,
  CHUNK_SIZE,
  DASH_LENGTH,
  LABEL_LISTS,
  JSON_COLORS,
  MASK_LABELS,
  DATE_TIME,
  HEATMAP,
  BASE_ALPHA,
} from "./constants";
import {
  getFrameElements,
  getImageElements,
  getVideoElements,
} from "./elements";
import {
  COMMON_SHORTCUTS,
  LookerElement,
  VIDEO_SHORTCUTS,
} from "./elements/common";
import processOverlays from "./processOverlays";
import { ClassificationsOverlay, FROM_FO, loadOverlays } from "./overlays";
import { CONTAINS, Overlay } from "./overlays/base";
import {
  FrameState,
  ImageState,
  VideoState,
  StateUpdate,
  BaseState,
  DEFAULT_FRAME_OPTIONS,
  DEFAULT_IMAGE_OPTIONS,
  DEFAULT_VIDEO_OPTIONS,
  Coordinates,
  Optional,
  FrameChunkResponse,
  VideoSample,
  FrameSample,
  Buffers,
  LabelData,
  BufferRange,
  Dimensions,
  Sample,
  MaskTargets,
} from "./state";
import {
  addToBuffers,
  createWorker,
  getDPR,
  getElementBBox,
  getFitRect,
  getMimeType,
  getURL,
  mergeUpdates,
  removeFromBuffers,
  snapBox,
} from "./util";

import { zoomToContent } from "./zoom";

import { getFrameNumber } from "./elements/util";
import { getColor } from "./color";

export { zoomAspectRatio } from "./zoom";
export { freeVideos } from "./elements/util";
export { createColorGenerator, getRGB } from "./color";

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

export interface Coloring {
  byLabel: boolean;
  pool: string[];
  scale: RGB[];
  seed: number;
  targets: string[];
  defaultMaskTargets?: MaskTargets;
  maskTargets: {
    [field: string]: MaskTargets;
  };
}

const workerCallbacks = {
  requestColor: [
    (worker, { key, pool, seed }) => {
      worker.postMessage({
        method: "resolveColor",
        key,
        seed,
        color: getColor(pool, seed, key),
      });
    },
  ],
};

const getLabelsWorker = (() => {
  // one labels worker seems to be best
  // const numWorkers = navigator.hardwareConcurrency || 4;
  const numWorkers = 1;

  const workers = [];
  for (let i = 0; i < numWorkers; i++) {
    workers.push(createWorker(workerCallbacks));
  }

  let next = -1;
  return () => {
    next++;
    next %= numWorkers;
    return workers[next];
  };
})();

export abstract class Looker<
  State extends BaseState = BaseState,
  S extends Sample = Sample
> {
  private eventTarget: EventTarget;
  protected lookerElement: LookerElement<State>;
  private resizeObserver: ResizeObserver;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private previousState?: Readonly<State>;

  protected sampleOverlays: Overlay<State>[];
  protected currentOverlays: Overlay<State>[];
  protected pluckedOverlays: Overlay<State>[];
  protected sample: S;
  protected state: State;
  protected readonly updater: StateUpdate<State>;

  constructor(
    sample: S,
    config: State["config"],
    options: Optional<State["options"]> = {}
  ) {
    this.eventTarget = new EventTarget();
    this.updater = this.makeUpdate();
    this.state = this.getInitialState(config, options);
    this.loadSample(sample);
    this.state.options.mimetype = getMimeType(sample);
    if (!this.state.config.thumbnail) {
      this.state.showControls = true;
    }
    this.pluckedOverlays = [];
    this.currentOverlays = [];
    this.lookerElement = this.getElements(config);
    this.canvas = this.lookerElement.children[1].element as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d");

    this.resizeObserver = new ResizeObserver(() => {
      const box = getElementBBox(this.lookerElement.element);
      box[2] &&
        box[3] &&
        this.lookerElement &&
        this.updater({
          windowBBox: box,
        });
    });
  }

  loadOverlays(sample: Sample): void {
    this.sampleOverlays = loadOverlays(sample);
  }

  pluckOverlays(state: Readonly<State>): Overlay<State>[] {
    return this.sampleOverlays;
  }

  protected dispatchEvent(eventType: string, detail: any): void {
    if (eventType === "error") {
      this.updater({ error: detail.error || true });
    }

    this.eventTarget.dispatchEvent(new CustomEvent(eventType, { detail }));
  }

  protected dispatchImpliedEvents(
    previousState: Readonly<State>,
    state: Readonly<State>
  ): void {}

  protected getDispatchEvent(): (eventType: string, detail: any) => void {
    return (eventType: string, detail: any) => {
      if (eventType === "copy") {
        this.getSample().then((sample) =>
          copyToClipboard(JSON.stringify(sample, null, 4))
        );
        return;
      }

      if (eventType === "selectthumbnail") {
        this.dispatchEvent(eventType, this.sample.id);
        return;
      }

      this.dispatchEvent(eventType, detail);
    };
  }

  private makeUpdate(): StateUpdate<State> {
    return (stateOrUpdater, postUpdate) => {
      const updates =
        stateOrUpdater instanceof Function
          ? stateOrUpdater(this.state)
          : stateOrUpdater;
      if (
        !this.lookerElement ||
        (Object.keys(updates).length === 0 && !postUpdate)
      ) {
        return;
      }

      this.previousState = this.state;
      this.state = mergeUpdates(this.state, updates);

      if (
        !this.state.windowBBox ||
        this.state.destroyed ||
        !this.state.overlaysPrepared
      ) {
        return;
      }

      this.pluckedOverlays = this.pluckOverlays(this.state);
      this.state = this.postProcess();

      [this.currentOverlays, this.state.rotate] = processOverlays(
        this.state,
        this.pluckedOverlays
      );

      this.state.mouseIsOnOverlay =
        Boolean(this.currentOverlays.length) &&
        this.currentOverlays[0].containsPoint(this.state) > CONTAINS.NONE;
      postUpdate && postUpdate(this.state, this.currentOverlays);

      this.dispatchImpliedEvents(this.previousState, this.state);

      if (this.state.options.showJSON) {
        const pre = this.lookerElement.element.querySelectorAll("pre")[0];
        this.getSample().then((sample) => {
          pre.innerHTML = highlightJSON(sample, JSON_COLORS);
        });
      }
      const ctx = this.ctx;
      this.lookerElement.render(this.state, this.sample);

      if (!this.state.loaded || this.state.destroyed || this.waiting) {
        return;
      }

      ctx.lineWidth = this.state.strokeWidth;
      ctx.font = `bold ${this.state.fontSize.toFixed(2)}px Palanquin`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const dpr = getDPR();
      ctx.clearRect(
        0,
        0,
        this.state.windowBBox[2] * dpr,
        this.state.windowBBox[3] * dpr
      );

      ctx.translate(this.state.pan[0] * dpr, this.state.pan[1] * dpr);
      const scale = this.state.scale * dpr;
      ctx.scale(scale, scale);

      const [tlx, tly, w, h] = this.state.canvasBBox;
      ctx.drawImage(
        this.getImageSource(),
        0,
        0,
        this.state.config.dimensions[0],
        this.state.config.dimensions[1],
        tlx,
        tly,
        w,
        h
      );

      ctx.globalAlpha = Math.min(1, this.state.options.alpha / BASE_ALPHA);
      const numOverlays = this.currentOverlays.length;
      for (let index = numOverlays - 1; index >= 0; index--) {
        this.currentOverlays[index].draw(ctx, this.state);
      }
      ctx.globalAlpha = 1;
    };
  }

  addEventListener(
    eventType: string,
    handler: EventListenerOrEventListenerObject | null,
    ...args: any[]
  ) {
    this.eventTarget.addEventListener(eventType, handler, ...args);
  }

  removeEventListener(
    eventType: string,
    handler: EventListenerOrEventListenerObject | null,
    ...args: any[]
  ) {
    this.eventTarget.removeEventListener(eventType, handler, ...args);
  }

  attach(element: HTMLElement | string, dimensions?: Dimensions): void {
    if (typeof element === "string") {
      element = document.getElementById(element);
    }

    if (element === this.lookerElement.element.parentElement) {
      this.state.disabled && this.updater({ disabled: false });
      return;
    }

    if (this.lookerElement.element.parentElement) {
      this.resizeObserver.disconnect();
      this.lookerElement.element.parentElement.removeChild(
        this.lookerElement.element
      );
    }

    this.updater({
      windowBBox: dimensions ? [0, 0, ...dimensions] : getElementBBox(element),
    });
    element.appendChild(this.lookerElement.element);
    !dimensions && this.resizeObserver.observe(element);
  }

  resize(dimensions: Dimensions): void {
    this.updater({
      windowBBox: [0, 0, ...dimensions],
    });
  }

  detach(): void {
    this.resizeObserver.disconnect();
    this.lookerElement.element.parentNode &&
      this.lookerElement.element.parentNode.removeChild(
        this.lookerElement.element
      );
  }

  abstract updateOptions(options: Optional<State["options"]>): void;

  updateSample(sample: Sample) {
    this.loadSample(sample);
  }

  getSample(): Promise<Sample> {
    let sample = { ...this.sample };

    return Promise.resolve(
      filterSample(this.state, sample, this.state.options.fieldsMap)
    );
  }

  getCurrentSampleLabels(): LabelData[] {
    const labels: LabelData[] = [];
    this.currentOverlays.forEach((overlay) => {
      if (overlay instanceof ClassificationsOverlay) {
        overlay.getFilteredAndFlat(this.state).forEach(([field, label]) => {
          labels.push({
            field: field,
            label_id: label.id,
            sample_id: this.sample.id,
          });
        });
      } else {
        const { id: label_id, field } = overlay.getSelectData(this.state);
        labels.push({ label_id, field, sample_id: this.sample.id });
      }
    });

    return labels;
  }

  protected get waiting() {
    return false;
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.lookerElement.element.parentElement &&
      this.lookerElement.element.parentElement.removeChild(
        this.lookerElement.element
      );
    this.updater({ destroyed: true });
  }
  disable() {
    this.updater({ disabled: true });
  }

  protected abstract hasDefaultZoom(
    state: State,
    overlays: Overlay<State>[]
  ): boolean;

  protected abstract getElements(
    config: Readonly<State["config"]>
  ): LookerElement<State>;

  protected abstract getDefaultOptions(): State["options"];

  protected abstract getInitialState(
    config: State["config"],
    options: Optional<State["options"]>
  ): State;

  protected getImageSource(): CanvasImageSource {
    return this.lookerElement.children[0].imageSource;
  }

  protected getInitialBaseState(): Omit<BaseState, "config" | "options"> {
    return {
      disabled: false,
      cursorCoordinates: [0, 0],
      pixelCoordinates: [0, 0],
      relativeCoordinates: [0, 0],
      disableControls: false,
      hovering: false,
      hoveringControls: false,
      showControls: false,
      showHelp: false,
      showOptions: false,
      loaded: false,
      scale: 1,
      pan: <Coordinates>[0, 0],
      rotate: 0,
      panning: false,
      strokeWidth: STROKE_WIDTH,
      dashLength: DASH_LENGTH,
      fontSize: FONT_SIZE,
      wheeling: false,
      transformedWindowBBox: null,
      windowBBox: null,
      transformedMediaBBox: null,
      mediaBBox: null,
      canvasBBox: null,
      textPad: PAD,
      pointRadius: POINT_RADIUS,
      mouseIsOnOverlay: false,
      overlaysPrepared: false,
      disableOverlays: false,
      zoomToContent: false,
      setZoom: true,
      hasDefaultZoom: true,
      SHORTCUTS: COMMON_SHORTCUTS,
      error: null,
      destroyed: false,
      reloading: false,
    };
  }

  protected postProcess(): State {
    let [tlx, tly, w, h] = this.state.windowBBox;
    this.state.pan = snapBox(
      this.state.scale,
      this.state.pan,
      [w, h],
      this.state.config.dimensions
    );
    this.state.mediaBBox = getFitRect(
      this.state.config.dimensions,
      this.state.windowBBox
    );
    this.state.transformedWindowBBox = [
      tlx + this.state.pan[0],
      tly + this.state.pan[1],
      this.state.scale * w,
      this.state.scale * h,
    ];

    this.state.transformedMediaBBox = getFitRect(
      this.state.config.dimensions,
      this.state.transformedWindowBBox
    );
    this.state.canvasBBox = [
      this.state.mediaBBox[0] - this.state.windowBBox[0],
      this.state.mediaBBox[1] - this.state.windowBBox[1],
      this.state.mediaBBox[2],
      this.state.mediaBBox[3],
    ];
    this.state.relativeCoordinates = [
      (this.state.cursorCoordinates[0] - this.state.transformedMediaBBox[0]) /
        this.state.transformedMediaBBox[2],
      (this.state.cursorCoordinates[1] - this.state.transformedMediaBBox[1]) /
        this.state.transformedMediaBBox[3],
    ];
    this.state.pixelCoordinates = [
      this.state.relativeCoordinates[0] * this.state.config.dimensions[0],
      this.state.relativeCoordinates[1] * this.state.config.dimensions[1],
    ];
    this.state.fontSize = FONT_SIZE / this.state.scale;
    this.state.pointRadius = POINT_RADIUS / this.state.scale;
    this.state.strokeWidth = STROKE_WIDTH / this.state.scale;
    this.state.dashLength = DASH_LENGTH / this.state.scale;
    this.state.config.thumbnail && (this.state.strokeWidth /= 3);
    this.state.textPad = PAD / this.state.scale;

    this.state.hasDefaultZoom = this.hasDefaultZoom(
      this.state,
      this.pluckedOverlays
    );

    return this.state;
  }

  protected hasResized(): boolean {
    return Boolean(
      !this.previousState?.windowBBox ||
        !this.state?.windowBBox ||
        this.previousState.windowBBox.some(
          (v, i) => v !== this.state.windowBBox[i]
        )
    );
  }

  private loadSample(sample: Sample) {
    const messageUUID = uuid();
    const worker = getLabelsWorker();
    const listener = ({ data: { sample, uuid } }) => {
      if (uuid === messageUUID) {
        this.sample = sample;
        this.loadOverlays(sample);
        this.updater({
          overlaysPrepared: true,
          disabled: false,
          reloading: false,
        });
        worker.removeEventListener("message", listener);
      }
    };
    worker.addEventListener("message", listener);
    worker.postMessage({
      method: "processSample",
      coloring: this.state.options.coloring,
      sample,
      uuid: messageUUID,
    });
  }
}

export class FrameLooker extends Looker<FrameState> {
  getElements(config) {
    return getFrameElements(config, this.updater, this.getDispatchEvent());
  }

  getInitialState(
    config: FrameState["config"],
    options: FrameState["options"]
  ) {
    options = {
      ...this.getDefaultOptions(),
      ...options,
    };
    return {
      duration: null,
      ...this.getInitialBaseState(),
      config: { ...config },
      options,
      SHORTCUTS: COMMON_SHORTCUTS,
    };
  }

  getDefaultOptions() {
    return DEFAULT_FRAME_OPTIONS;
  }

  hasDefaultZoom(state: FrameState, overlays: Overlay<FrameState>[]): boolean {
    let pan = [0, 0];
    let scale = 1;

    if (state.options.zoom) {
      const zoomState = zoomToContent(state, overlays);
      pan = zoomState.pan;
      scale = zoomState.scale;
    }

    return (
      scale === state.scale &&
      pan[0] === state.pan[0] &&
      pan[1] === state.pan[1]
    );
  }

  postProcess(): FrameState {
    if (!this.state.setZoom) {
      this.state.setZoom = this.hasResized();
    }

    if (this.state.zoomToContent) {
      toggleZoom(this.state, this.currentOverlays);
    } else if (this.state.setZoom && this.state.overlaysPrepared) {
      if (this.state.options.zoom) {
        this.state = zoomToContent(this.state, this.pluckedOverlays);
      } else {
        this.state.pan = [0, 0];
        this.state.scale = 1;
      }

      this.state.setZoom = false;
    }

    return super.postProcess();
  }

  updateOptions(options: Optional<FrameState["options"]>) {
    const reload = shouldReloadSample(this.state.options, options);
    const state: Optional<FrameState> = { options };
    if (options.zoom !== undefined) {
      state.setZoom = this.state.options.zoom !== options.zoom;
    }

    if (reload) {
      this.updater({ ...state, reloading: this.state.disabled });
      this.updateSample(this.sample);
    } else {
      this.updater({ ...state, disabled: false });
    }
  }
}

export class ImageLooker extends Looker<ImageState> {
  getElements(config) {
    return getImageElements(config, this.updater, this.getDispatchEvent());
  }

  getInitialState(
    config: ImageState["config"],
    options: ImageState["options"]
  ) {
    options = {
      ...this.getDefaultOptions(),
      ...options,
    };

    return {
      ...this.getInitialBaseState(),
      config: { ...config },
      options,
      SHORTCUTS: COMMON_SHORTCUTS,
    };
  }

  getDefaultOptions() {
    return DEFAULT_IMAGE_OPTIONS;
  }

  hasDefaultZoom(state: ImageState, overlays: Overlay<ImageState>[]): boolean {
    let pan = [0, 0];
    let scale = 1;

    if (state.options.zoom) {
      const zoomState = zoomToContent(state, overlays);
      pan = zoomState.pan;
      scale = zoomState.scale;
    }

    return (
      scale === state.scale &&
      pan[0] === state.pan[0] &&
      pan[1] === state.pan[1]
    );
  }

  postProcess(): ImageState {
    if (!this.state.setZoom) {
      this.state.setZoom = this.hasResized();
    }

    if (this.state.zoomToContent) {
      toggleZoom(this.state, this.currentOverlays);
    } else if (this.state.setZoom && this.state.overlaysPrepared) {
      if (this.state.options.zoom) {
        this.state = zoomToContent(this.state, this.pluckedOverlays);
      } else {
        this.state.pan = [0, 0];
        this.state.scale = 1;
      }

      this.state.setZoom = false;
    }

    return super.postProcess();
  }

  updateOptions(options: Optional<ImageState["options"]>) {
    const reload = shouldReloadSample(this.state.options, options);
    const state: Optional<ImageState> = { options };
    if (options.zoom !== undefined) {
      state.setZoom =
        this.state.options.zoom !== options.zoom || this.state.config.thumbnail;
    }

    if (reload) {
      this.updater({ ...state, reloading: this.state.disabled });
      this.updateSample(this.sample);
    } else {
      this.updater({ ...state, disabled: false });
    }
  }
}

interface Frame {
  sample: FrameSample;
  overlays: Overlay<VideoState>[];
}

type RemoveFrame = (frameNumber: number) => void;

interface AcquireReaderOptions {
  addFrame: (frameNumber: number, frame: Frame) => void;
  addFrameBuffers: (range: [number, number]) => void;
  removeFrame: RemoveFrame;
  getCurrentFrame: () => number;
  sampleId: string;
  frameNumber: number;
  frameCount: number;
  update: StateUpdate<VideoState>;
  dispatchEvent: (eventType: string, detail: any) => void;
  coloring: Coloring;
}

const { aquireReader, addFrame } = (() => {
  const createCache = () =>
    new LRU<WeakRef<RemoveFrame>, Frame>({
      max: MAX_FRAME_CACHE_SIZE_BYTES,
      length: (frame) => {
        let size = 1;
        frame.overlays.forEach((overlay) => {
          size += overlay.getSizeBytes();
        });
        return size;
      },
      dispose: (removeFrameRef, frame) => {
        const removeFrame = removeFrameRef.deref();
        removeFrame && removeFrame(frame.sample.frame_number);
      },
    });

  let frameCache = createCache();
  let frameReader: Worker;

  let streamSize = 0;
  let nextRange: BufferRange = null;

  let requestingFrames: boolean = false;
  let currentOptions: AcquireReaderOptions = null;

  const setStream = ({
    addFrame,
    addFrameBuffers,
    removeFrame,
    frameNumber,
    frameCount,
    sampleId,
    update,
    dispatchEvent,
    coloring,
  }: AcquireReaderOptions): string => {
    streamSize = 0;
    nextRange = [frameNumber, Math.min(frameCount, CHUNK_SIZE + frameNumber)];
    const subscription = uuid();
    frameReader && frameReader.terminate();
    frameReader = createWorker(workerCallbacks);
    frameReader.onmessage = ({ data }: MessageEvent<FrameChunkResponse>) => {
      if (data.error) {
        dispatchEvent("error", { error: "Frames" });
      }

      if (data.uuid !== subscription || data.method !== "frameChunk") {
        return;
      }

      const {
        frames,
        range: [start, end],
      } = data;
      addFrameBuffers([start, end]);
      for (let i = start; i <= end; i++) {
        const frame = {
          sample: {
            frame_number: i,
          },
          overlays: [],
        };
        frameCache.set(new WeakRef(removeFrame), frame);
        addFrame(i, frame);
      }

      for (let i = 0; i < frames.length; i++) {
        const frameSample = frames[i];
        const prefixedFrameSample = Object.fromEntries(
          Object.entries(frameSample).map(([k, v]) => ["frames." + k, v])
        );

        const overlays = loadOverlays(prefixedFrameSample);
        overlays.forEach((overlay) => {
          streamSize += overlay.getSizeBytes();
        });
        const frame = { sample: frameSample, overlays };
        frameCache.set(new WeakRef(removeFrame), frame);
        addFrame(frameSample.frame_number, frame);
      }

      const requestMore = streamSize < MAX_FRAME_CACHE_SIZE_BYTES;

      if (requestMore && end < frameCount) {
        nextRange = [end + 1, Math.min(frameCount, end + 1 + CHUNK_SIZE)];
        requestingFrames = true;
        frameReader.postMessage({
          method: "requestFrameChunk",
          uuid: subscription,
        });
      } else {
        requestingFrames = false;
        nextRange = null;
      }

      update((state) => {
        state.buffering && dispatchEvent("buffering", false);
        return { buffering: false };
      });
    };

    requestingFrames = true;
    frameReader.postMessage({
      method: "setStream",
      sampleId,
      frameCount,
      frameNumber,
      uuid: subscription,
      url: getURL(),
      coloring,
    });
    return subscription;
  };

  return {
    aquireReader: (
      options: AcquireReaderOptions
    ): ((frameNumber?: number) => void) => {
      currentOptions = options;
      let subscription = setStream(currentOptions);

      return (frameNumber: number, force?: boolean) => {
        if (
          force ||
          !nextRange ||
          (frameNumber < nextRange[0] && frameNumber > nextRange[1])
        ) {
          force && frameCache.reset();
          nextRange = [frameNumber, frameNumber + CHUNK_SIZE];
          subscription = setStream({ ...currentOptions, frameNumber });
        } else if (!requestingFrames) {
          frameReader.postMessage({
            method: "requestFrameChunk",
            uuid: subscription,
          });
        }
        requestingFrames = true;
      };
    },
    addFrame: (removeFrame: RemoveFrame, frame: Frame): void => {
      frameCache.set(new WeakRef(removeFrame), frame);
    },
  };
})();

let lookerWithReader: VideoLooker | null = null;

export class VideoLooker extends Looker<VideoState, VideoSample> {
  private frames: Map<number, WeakRef<Frame>> = new Map();
  private requestFrames: (frameNumber: number, force?: boolean) => void;

  get frameNumber() {
    return this.state.frameNumber;
  }

  get playing() {
    return this.state.playing;
  }

  get waiting() {
    const video = this.lookerElement.children[0].element as HTMLVideoElement;
    return (
      video &&
      (video.seeking ||
        video.readyState < 2 ||
        !this.hasFrame(this.state.frameNumber))
    );
  }

  destroy() {
    this.pause();
    super.destroy();
  }

  dispatchImpliedEvents(
    previousState: Readonly<VideoState>,
    state: Readonly<VideoState>
  ): void {
    const previousPlaying = previousState.playing && !previousState.buffering;
    const playing = state.playing && !state.buffering;

    if (previousPlaying !== playing) {
      playing && this.dispatchEvent("play", null);
      !playing && this.dispatchEvent("pause", { buffering: state.buffering });
    }
  }

  getCurrentSampleLabels(): LabelData[] {
    const labels: LabelData[] = [];
    processOverlays(this.state, this.sampleOverlays)[0].forEach((overlay) => {
      if (overlay instanceof ClassificationsOverlay) {
        overlay.getFilteredAndFlat(this.state).forEach(([field, label]) => {
          labels.push({
            field: field,
            label_id: label.id,
            sample_id: this.sample.id,
          });
        });
      } else {
        const { id: label_id, field } = overlay.getSelectData(this.state);
        labels.push({ label_id, field, sample_id: this.sample.id });
      }
    });

    return labels;
  }

  getCurrentFrameLabels(): LabelData[] {
    const frame = this.frames.get(this.frameNumber).deref();
    const labels: LabelData[] = [];
    if (frame) {
      processOverlays(this.state, frame.overlays)[0].forEach((overlay) => {
        if (overlay instanceof ClassificationsOverlay) {
          overlay.getFilteredAndFlat(this.state).forEach(([field, label]) => {
            labels.push({
              field: field,
              label_id: label.id,
              frame_number: this.frameNumber,
              sample_id: this.sample.id,
            });
          });
        } else {
          const { id: label_id, field } = overlay.getSelectData(this.state);
          labels.push({
            label_id,
            field,
            sample_id: this.sample.id,
            frame_number: this.frameNumber,
          });
        }
      });
    }

    return labels;
  }

  getElements(config) {
    return getVideoElements(config, this.updater, this.getDispatchEvent());
  }

  getInitialState(
    config: VideoState["config"],
    options: VideoState["options"]
  ): VideoState {
    const firstFrame = config.support ? config.support[0] : 1;

    return {
      duration: null,
      seeking: false,
      fragment: null,
      playing: false,
      frameNumber: firstFrame,
      buffering: false,
      ...this.getInitialBaseState(),
      config: { ...config },
      options: {
        ...this.getDefaultOptions(),
        ...options,
      },
      buffers: [[firstFrame, firstFrame]] as Buffers,
      seekBarHovering: false,
      SHORTCUTS: VIDEO_SHORTCUTS,
      hasPoster: false,
      waitingForVideo: false,
      lockedToSupport: Boolean(config.support),
    };
  }

  hasDefaultZoom(state: VideoState, overlays: Overlay<VideoState>[]): boolean {
    let pan = [0, 0];
    let scale = 1;

    return (
      scale === state.scale &&
      pan[0] === state.pan[0] &&
      pan[1] === state.pan[1]
    );
  }

  loadOverlays(sample: VideoSample) {
    this.sampleOverlays = loadOverlays(
      Object.fromEntries(
        Object.entries(sample).filter(([fieldName]) => fieldName !== "frames")
      ),
      true
    );

    const providedFrames = sample.frames.length
      ? sample.frames
      : [{ frame_number: 1 }];
    const providedFrameOverlays = providedFrames.map((frameSample) =>
      loadOverlays(
        Object.fromEntries(
          Object.entries(frameSample).map(([k, v]) => ["frames." + k, v])
        )
      )
    );

    const frames = providedFrames.map((frameSample, i) => ({
      sample: frameSample as FrameSample,
      overlays: providedFrameOverlays[i],
    }));
    frames.forEach((frame) => {
      const frameNumber = frame.sample.frame_number;
      addFrame(
        (frameNumber) => removeFromBuffers(frameNumber, this.state.buffers),
        frame
      );
      this.frames.set(frame.sample.frame_number, new WeakRef(frame));
      addToBuffers([frameNumber, frameNumber], this.state.buffers);
    });
  }

  pluckOverlays(state: VideoState) {
    const frameNumber = state.frameNumber;
    let hideSampleOverlays = false;

    if (state.config.support && !state.lockedToSupport) {
      const [start, end] = state.config.support;
      hideSampleOverlays = frameNumber < start || frameNumber > end;
    }

    let pluckedOverlays = hideSampleOverlays ? [] : this.sampleOverlays;
    if (this.hasFrame(state.frameNumber)) {
      const frame = this.frames.get(state.frameNumber)?.deref();
      if (frame !== undefined) {
        pluckedOverlays = [...pluckedOverlays, ...frame.overlays];
      }
    }

    let frameCount = null;

    if (this.state.duration !== null) {
      frameCount = getFrameNumber(
        this.state.duration,
        this.state.duration,
        this.state.config.frameRate
      );
    }

    if (
      (!state.config.thumbnail || state.playing) &&
      lookerWithReader !== this &&
      frameCount !== null
    ) {
      lookerWithReader && lookerWithReader.pause();
      this.setReader();
      lookerWithReader = this;
      this.state.buffers = [[1, 1]];
    } else if (lookerWithReader !== this && frameCount) {
      this.state.buffering && this.dispatchEvent("buffering", false);
      this.state.playing = false;
      this.state.buffering = false;
    }

    if (lookerWithReader === this) {
      if (this.hasFrame(Math.min(frameCount, state.frameNumber + 1))) {
        this.state.buffering && this.dispatchEvent("buffering", false);
        this.state.buffering = false;
      } else {
        this.state.buffering = true;
        this.dispatchEvent("buffering", true);
        this.requestFrames(state.frameNumber);
      }
    }

    return pluckedOverlays;
  }

  private setReader() {
    this.requestFrames = aquireReader({
      addFrame: (frameNumber, frame) =>
        this.frames.set(frameNumber, new WeakRef(frame)),
      addFrameBuffers: (range) =>
        (this.state.buffers = addToBuffers(range, this.state.buffers)),
      removeFrame: (frameNumber) =>
        removeFromBuffers(frameNumber, this.state.buffers),
      getCurrentFrame: () => this.frameNumber,
      sampleId: this.state.config.sampleId,
      frameCount: getFrameNumber(
        this.state.duration,
        this.state.duration,
        this.state.config.frameRate
      ),
      frameNumber: this.state.frameNumber,
      update: this.updater,
      dispatchEvent: (event, detail) => this.dispatchEvent(event, detail),
      coloring: this.state.options.coloring,
    });
  }

  getSample(): Promise<VideoSample> {
    return new Promise((resolve) => {
      const resolver = (sample) => {
        if (this.hasFrame(this.state.frameNumber)) {
          resolve({
            ...sample,
            frames: [
              {
                frame_number: this.frameNumber,
                ...filterSample(
                  this.state,
                  { ...this.frames.get(this.frameNumber).deref().sample },
                  this.state.options.frameFieldsMap,
                  "frames."
                ),
              },
            ],
          });
          return;
        }
        setTimeout(resolver, 200);
      };
      super.getSample().then(resolver);
    });
  }

  getDefaultOptions() {
    return DEFAULT_VIDEO_OPTIONS;
  }

  play(): void {
    this.updater(({ playing }) => {
      if (!playing) {
        return { playing: true };
      }
      return {};
    });
  }

  pause(): void {
    this.updater(({ playing }) => {
      if (playing) {
        return { playing: false };
      }
      return {};
    });
  }

  postProcess(): VideoState {
    if (this.state.seeking) {
      this.state.disableOverlays = true;
    } else if (!this.state.playing && !this.state.buffering) {
      this.state.disableOverlays = false;
    }
    if (!this.state.setZoom) {
      this.state.setZoom = this.hasResized();
    }

    if (!this.state.setZoom) {
      this.state.setZoom = this.hasResized();
    }

    if (this.state.zoomToContent) {
      toggleZoom(this.state, this.currentOverlays);
    } else if (this.state.setZoom) {
      this.state.pan = [0, 0];
      this.state.scale = 1;

      this.state.setZoom = false;
    }

    return super.postProcess();
  }

  updateOptions(options: Optional<VideoState["options"]>) {
    const reload = shouldReloadSample(this.state.options, options);

    if (reload) {
      this.updater({ options, reloading: this.state.disabled });
      this.updateSample(this.sample);
    } else {
      this.updater({ options, disabled: false });
    }
  }

  updateSample(sample: VideoSample) {
    this.state.buffers = [[1, 1]];
    this.frames.clear();
    super.updateSample(sample);
    this.setReader();
  }

  private hasFrame(frameNumber: number) {
    return (
      this.frames.has(frameNumber) &&
      this.frames.get(frameNumber)?.deref() !== undefined
    );
  }
}

const toggleZoom = <State extends FrameState | ImageState | VideoState>(
  state: State,
  overlays: Overlay<State>[]
) => {
  if (state.options.selectedLabels) {
    const ids = new Set(state.options.selectedLabels);
    const selected = overlays.filter((o) => {
      if (o instanceof ClassificationsOverlay) {
        return false;
      }

      return ids.has(o.getSelectData(state).id);
    });

    if (selected.length) {
      overlays = selected;
    }
  }
  const { pan, scale } = zoomToContent(state, overlays);

  if (
    state.pan[0] === pan[0] &&
    state.pan[1] === pan[1] &&
    state.scale === scale
  ) {
    state.pan = [0, 0];
    state.scale = 1;
  } else {
    state.pan = pan;
    state.scale = scale;
  }

  state.zoomToContent = false;
};

const filterSample = <S extends Sample | FrameSample>(
  state: Readonly<BaseState>,
  sample: S,
  fieldsMap: { [key: string]: string },
  prefix = ""
): S => {
  for (let field in sample) {
    if (fieldsMap.hasOwnProperty(field)) {
      sample[fieldsMap[field]] = sample[field];
      if (field !== fieldsMap[field]) {
        delete sample[field];
      }
    } else if (field.startsWith("_")) {
      delete sample[field];
    } else if (sample[field] && sample[field]._cls === DATE_TIME) {
      sample[field] = new Date(sample[field].datetime);
    } else if (Array.isArray(sample[field])) {
      sample[field] = sample[field].map((v) =>
        v && v._cls === DATE_TIME ? new Date(sample[field].datetime) : v
      );
    } else if (
      sample[field] &&
      sample[field]._cls &&
      FROM_FO.hasOwnProperty(sample[field]._cls)
    ) {
      if (!state.options.activePaths.includes(prefix + field)) {
        delete sample[field];
        continue;
      }

      if (LABEL_LISTS[sample[field]._cls]) {
        sample[field] = {
          ...sample[field],
          [LABEL_LISTS[sample[field]._cls]]: sample[field][
            LABEL_LISTS[sample[field]._cls]
          ]
            .filter((label) => state.options.filter[prefix + field](label))
            .map((label) => {
              if (MASK_LABELS.has(label._cls) && label.mask) {
                label.mask = {
                  shape: label.mask.shape,
                };
              }

              return label;
            }),
        };
      } else if (!state.options.filter[prefix + field](sample[field])) {
        delete sample[field];
      } else if (
        MASK_LABELS.has(sample[field]._cls) &&
        sample[field].mask &&
        sample[field].mask.data
      ) {
        sample[field] = {
          ...sample[field],
          mask: {
            shape: sample[field].mask.data.shape,
          },
        };
      } else if (
        sample[field]._cls === HEATMAP &&
        sample[field].map &&
        sample[field].map.data
      ) {
        sample[field] = {
          ...sample[field],
          map: {
            shape: sample[field].map.data.shape,
          },
        };
      }
    }
  }
  return sample;
};

const shouldReloadSample = (
  current: Readonly<BaseState["options"]>,
  next: Readonly<Optional<BaseState["options"]>>
): boolean => {
  let reloadSample = false;
  if (next.coloring && current.coloring.seed !== next.coloring.seed) {
    reloadSample = true;
  } else if (
    next.coloring &&
    next.coloring.byLabel !== current.coloring.byLabel
  ) {
    reloadSample = true;
  }

  return reloadSample;
};
