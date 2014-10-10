module Shumway.GFX.Canvas2D {

  import assert = Shumway.Debug.assert;
  import Rectangle = Shumway.GFX.Geometry.Rectangle;
  import Point = Shumway.GFX.Geometry.Point;
  import Matrix = Shumway.GFX.Geometry.Matrix;
  import DirtyRegion = Shumway.GFX.Geometry.DirtyRegion;
  import Filter = Shumway.GFX.Filter;
  import BlendMode = Shumway.GFX.BlendMode;
  import TileCache = Shumway.GFX.Geometry.TileCache;
  import Tile = Shumway.GFX.Geometry.Tile;
  import OBB = Shumway.GFX.Geometry.OBB;
  import MipMap = Shumway.GFX.Geometry.MipMap;

  declare var registerScratchCanvas;

  export enum FillRule {
    NonZero,
    EvenOdd
  }

  export class Canvas2DStageRendererOptions extends StageRendererOptions {
    /**
     * Whether to force snapping matrices to device pixels.
     */
    snapToDevicePixels: boolean = true;

    /**
     * Whether to force image smoothing when drawing images.
     */
    imageSmoothing: boolean = true;

    /**
     * Whether to enable blending.
     */
    blending: boolean = true;

    /**
     * Whether to enable filters.
     */
    filters: boolean = true;

    /**
     * Whether to cache shapes as images.
     */
    cacheShapes: boolean = false;

    /**
     * Shapes above this size are not cached.
     */
    cacheShapesMaxSize: number = 256;

    /**
     * Number of times a shape is rendered before it's elligible for caching.
     */
    cacheShapesThreshold: number = 16;

    /**
     * Enables alpha layer for the canvas context.
     */
    alpha: boolean = false;
  }

  /**
   * Rendering state threaded through rendering methods.
   */
  export class Canvas2DStageRendererState {
    constructor (
      public options: Canvas2DStageRendererOptions,
      public clipRegion: boolean = false,
      public ignoreMask: Frame = null) {
      // ...
    }
  }

  function applyFilters(context: CanvasRenderingContext2D, filters: Filter []) {
    removeFilters(context);
    for (var i = 0; i < filters.length; i++) {
      var filter = filters[i];
      if (filter instanceof BlurFilter) {
        var blurFilter = <BlurFilter>filter;
        Canvas2DStageRenderer._svgBlurFilter.setAttribute("stdDeviation",blurFilter.blurX + " " + blurFilter.blurY);
        context.filter = "url(#svgBlurFilter)";
      } else if (filter instanceof DropshadowFilter) {
        var dropshadowFilter = <DropshadowFilter>filter;
        Canvas2DStageRenderer._svgDropshadowFilterBlur.setAttribute("stdDeviation",
          dropshadowFilter.blurX + " " + dropshadowFilter.blurY
        );
        Canvas2DStageRenderer._svgDropshadowFilterOffset.setAttribute("dx", String(Math.cos(dropshadowFilter.angle * Math.PI / 180) * dropshadowFilter.distance * 2));
        Canvas2DStageRenderer._svgDropshadowFilterOffset.setAttribute("dy", String(Math.sin(dropshadowFilter.angle * Math.PI / 180) * dropshadowFilter.distance * 2));
        context.filter = "url(#svgDropShadowFilter)";
      }
    }
  }

  function removeFilters(context: CanvasRenderingContext2D) {
    context.filter = "";
  }

  var MAX_VIEWPORT = Rectangle.createMaxI16();

  export class Canvas2DStageRenderer extends StageRenderer {
    _options: Canvas2DStageRendererOptions;
    private _fillRule: string;
    context: CanvasRenderingContext2D;

    private static _initializedCaches: boolean = false;

    /**
     * Allocates temporary regions for performing image operations.
     */
    private static _surfaceCache: SurfaceRegionAllocator.ISurfaceRegionAllocator;

    /**
     * Allocates shape cache regions.
     */
    private static _shapeCache: SurfaceRegionAllocator.ISurfaceRegionAllocator;

    /**
     * Reusable blur filter SVG element.
     */
    static _svgBlurFilter: Element;

    /**
     * Reusable dropshadow filter SVG element.
     */
    static _svgDropshadowFilterBlur: Element;
    static _svgDropshadowFilterOffset: Element;

    constructor (
      canvas: HTMLCanvasElement,
      stage: Stage,
      options: Canvas2DStageRendererOptions = new Canvas2DStageRendererOptions()) {
      super(canvas, stage, options);
      var fillRule: FillRule = FillRule.NonZero;
      var context = this.context = canvas.getContext("2d", {alpha: options.alpha});
      this._viewport = new Rectangle(0, 0, canvas.width, canvas.height);
      this._fillRule = fillRule === FillRule.EvenOdd ? 'evenodd' : 'nonzero';
      context.fillRule = context.mozFillRule = this._fillRule;
      Canvas2DStageRenderer._prepareSurfaceAllocators();
      Canvas2DStageRenderer._prepareSVGFilters();
    }

    /**
     * Creates an SVG element and defines filters that are referenced in |canvas.filter| properties. We cannot
     * inline CSS filters because they don't expose independent blurX and blurY properties.
     * This only works in Firefox, and you have to set the 'canvas.filters.enabled' equal to |true|.
     */
    private static _prepareSVGFilters() {
      if (Canvas2DStageRenderer._svgBlurFilter) {
        return;
      }
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      var defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");

      var filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
      filter.setAttribute("id","svgBlurFilter");
      var gaussianFilter = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
      gaussianFilter.setAttribute("stdDeviation","0 0");
      filter.appendChild(gaussianFilter);
      defs.appendChild(filter);
      Canvas2DStageRenderer._svgBlurFilter = gaussianFilter;

      var filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
      filter.setAttribute("id","svgDropShadowFilter");
      var feGaussianFilter = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
      feGaussianFilter.setAttribute("in","SourceAlpha");
      feGaussianFilter.setAttribute("stdDeviation", "3");
      filter.appendChild(feGaussianFilter);
      Canvas2DStageRenderer._svgDropshadowFilterBlur = feGaussianFilter;

      var feOffset = document.createElementNS("http://www.w3.org/2000/svg", "feOffset");
      feOffset.setAttribute("dx","0");
      feOffset.setAttribute("dy","0");
      feOffset.setAttribute("result", "offsetblur");
      filter.appendChild(feOffset);
      Canvas2DStageRenderer._svgDropshadowFilterOffset = feOffset;

//      var feFlood = document.createElementNS("http://www.w3.org/2000/svg", "feFlood");
//      feFlood.setAttribute("flood-color","rgba(0,0,0,0.5)");
//      filter.appendChild(feFlood);
//
//      var feComposite = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
//      feComposite.setAttribute("in2","offsetblur");
//      feComposite.setAttribute("operator","in");
//      filter.appendChild(feComposite);

      var feMerge = document.createElementNS("http://www.w3.org/2000/svg", "feMerge");
      var feMergeNode = document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode");
      feMerge.appendChild(feMergeNode);

      var feMergeNode = document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode");
      feMergeNode.setAttribute("in","SourceGraphic");
      feMerge.appendChild(feMergeNode);

      filter.appendChild(feMerge);

      defs.appendChild(filter);
      svg.appendChild(defs);
      document.documentElement.appendChild(svg);
    }

    private static _prepareSurfaceAllocators() {
      if (Canvas2DStageRenderer._initializedCaches) {
        return;
      }

      Canvas2DStageRenderer._surfaceCache = new SurfaceRegionAllocator.SimpleAllocator (
        function (w: number, h: number) {
          var canvas = document.createElement("canvas");
          if (typeof registerScratchCanvas !== "undefined") {
            registerScratchCanvas(canvas);
          }
          // Surface caches are at least this size.
          var W = Math.max(1024, w);
          var H = Math.max(1024, h);
          canvas.width = W;
          canvas.height = H;
          var allocator = null;
          if (w >= 1024 || h >= 1024) {
            // The requested size is pretty large, so create a single grid allocator
            // with there requested size. This will only hold one image.
            allocator = new RegionAllocator.GridAllocator(W, H, W, H);
          } else {
            allocator = new RegionAllocator.BucketAllocator(W, H);
          }
          return new Canvas2DSurface (
            canvas, allocator
          );
        }
      );

      Canvas2DStageRenderer._shapeCache = new SurfaceRegionAllocator.SimpleAllocator (
        function (w: number, h: number) {
          var canvas = document.createElement("canvas");
          if (typeof registerScratchCanvas !== "undefined") {
            registerScratchCanvas(canvas);
          }
          var W = 1024, H = 1024;
          canvas.width = W;
          canvas.height = H;
          // Shape caches can be compact since regions are never freed explicitly.
          var allocator = allocator = new RegionAllocator.CompactAllocator(W, H);
          return new Canvas2DSurface (
            canvas, allocator
          );
        }
      );

      Canvas2DStageRenderer._initializedCaches = true;
    }

    public resize() {
      var canvas = this._canvas, context = this.context;
      this._viewport = new Rectangle(0, 0, canvas.width, canvas.height);
      context.fillRule = context.mozFillRule = this._fillRule;

      this.render();
    }

    public render() {
      var stage = this._stage;
      var context = this.context;

      context.setTransform(1, 0, 0, 1, 0, 0);

      context.save();
      var options = this._options;

      var lastDirtyRectangles: Rectangle[] = [];
      var dirtyRectangles = lastDirtyRectangles.slice(0);

      context.globalAlpha = 1;

      var viewport = this._viewport;
      this.renderFrame(stage, viewport, stage.matrix, true);

      if (stage.trackDirtyRegions) {
        stage.dirtyRegion.clear();
      }

      context.restore();

      if (options && options.paintViewport) {
        context.beginPath();
        context.rect(viewport.x, viewport.y, viewport.w, viewport.h);
        context.strokeStyle = "#FF4981";
        context.stroke();
      }
    }

    public renderFrame (
      root: Frame,
      viewport: Rectangle,
      matrix: Matrix,
      clearTargetBeforeRendering: boolean = false)
    {
      var context = this.context;
      context.save();
      if (!this._options.paintViewport) {
        context.beginPath();
        context.rect(viewport.x, viewport.y, viewport.w, viewport.h);
        context.clip();
      }
      if (clearTargetBeforeRendering) {
        context.clearRect(viewport.x, viewport.y, viewport.w, viewport.h);
      }
      this._renderFrame(context, root, matrix, viewport, new Canvas2DStageRendererState(this._options));
      context.restore();
    }

    /**
     * Renders the frame into a temporary surface region in device coordinates clipped by the viewport.
     */
    private _renderToSurfaceRegion(frame: Frame, transform: Matrix, viewport: Rectangle): {
        surfaceRegion: Canvas2DSurfaceRegion;
        surfaceRegionBounds: Rectangle;
        clippedBounds: Rectangle;
      }
    {
      var bounds = frame.getBounds();
      var boundsAABB = bounds.clone();
      transform.transformRectangleAABB(boundsAABB);
      boundsAABB.snap();
      var dx = boundsAABB.x;
      var dy = boundsAABB.y;
      var clippedBoundsAABB = boundsAABB.clone();
      clippedBoundsAABB.intersect(viewport);
      clippedBoundsAABB.snap();

      dx += clippedBoundsAABB.x - boundsAABB.x;
      dy += clippedBoundsAABB.y - boundsAABB.y;

      var surfaceRegion = <Canvas2DSurfaceRegion>(Canvas2DStageRenderer._surfaceCache.allocate(clippedBoundsAABB.w, clippedBoundsAABB.h));
      var region = surfaceRegion.region;

      // Region bounds may be smaller than the allocated surface region.
      var surfaceRegionBounds = new Rectangle(region.x, region.y, clippedBoundsAABB.w, clippedBoundsAABB.h);

      var context = surfaceRegion.surface.context;
      context.setTransform(1, 0, 0, 1, 0, 0);
      // Prepare region bounds for painting.
      context.clearRect(surfaceRegionBounds.x, surfaceRegionBounds.y, surfaceRegionBounds.w, surfaceRegionBounds.h);
      transform = transform.clone();

      transform.translate (
        surfaceRegionBounds.x - dx,
        surfaceRegionBounds.y - dy
      );

      // Clip region bounds so we don't paint outside.
      context.save();
      context.beginPath();
      context.rect(surfaceRegionBounds.x, surfaceRegionBounds.y, surfaceRegionBounds.w, surfaceRegionBounds.h);
      context.clip();
      this._renderFrame(context, frame, transform, surfaceRegionBounds, new Canvas2DStageRendererState(this._options));
      context.restore();
      return {
        surfaceRegion: surfaceRegion,
        surfaceRegionBounds: surfaceRegionBounds,
        clippedBounds: clippedBoundsAABB
      };
    }

    private _renderShape(context: CanvasRenderingContext2D, shape: Shape, matrix: Matrix, viewport: Rectangle, state: Canvas2DStageRendererState) {
      var self = this;
      var bounds = shape.getBounds();
      if (!bounds.isEmpty() &&
          state.options.paintRenderable) {
        var source = shape.source;
        var renderCount = source.properties["renderCount"] || 0;
        var cacheShapesMaxSize = state.options.cacheShapesMaxSize;
        var matrixScale = Math.max(matrix.getAbsoluteScaleX(), matrix.getAbsoluteScaleY());
        if (!state.clipRegion &&
            !source.hasFlags(RenderableFlags.Dynamic) &&
            state.options.cacheShapes &&
            renderCount > state.options.cacheShapesThreshold &&
            bounds.w * matrixScale <= cacheShapesMaxSize &&
            bounds.h * matrixScale <= cacheShapesMaxSize) {
          var mipMap: MipMap = source.properties["mipMap"];
          if (!mipMap) {
            mipMap = source.properties["mipMap"] = new MipMap(source, Canvas2DStageRenderer._shapeCache, cacheShapesMaxSize);
          }
          var mipMapLevel = mipMap.getLevel(matrix);
          var mipMapLevelSurfaceRegion = <Canvas2DSurfaceRegion>(mipMapLevel.surfaceRegion);
          var region = mipMapLevelSurfaceRegion.region;
          if (mipMapLevel) {
            context.drawImage (
              mipMapLevelSurfaceRegion.surface.canvas,
              region.x, region.y,
              region.w, region.h,
              bounds.x, bounds.y,
              bounds.w, bounds.h
            );
          }
          if (state.options.paintFlashing) {
            context.fillStyle = ColorStyle.Green;
            context.globalAlpha = 0.5;
            context.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
          }
        } else {
          source.properties["renderCount"] = ++ renderCount;
          source.render(context, null, state.clipRegion);
          if (state.options.paintFlashing) {
            context.fillStyle = ColorStyle.randomStyle();
            context.globalAlpha = 0.1;
            context.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
          }
        }
      }
    }

    private _renderFrame (
      context: CanvasRenderingContext2D,
      root: Frame,
      matrix: Matrix,
      viewport: Rectangle,
      state: Canvas2DStageRendererState,
      skipRoot: boolean = false) {

      var self = this;
      root.visit(function visitFrame(frame: Frame, matrix?: Matrix, flags?: FrameFlags): VisitorFlags {
        if (skipRoot && root === frame) {
          return VisitorFlags.Continue;
        }

        if (!frame._hasFlags(FrameFlags.Visible)) {
          return VisitorFlags.Skip;
        }

        var bounds = frame.getBounds();

        if (state.ignoreMask !== frame && frame.mask && !state.clipRegion) {
          context.save();
          var maskMatrix = frame.mask.getConcatenatedMatrix();
          // If the mask doesn't have a parent, and therefore can't be a descentant of the stage object,
          // we still have to factor in the stage's matrix, which includes pixel density scaling.
          if (!frame.mask.parent) {
            maskMatrix = maskMatrix.concatClone(self._stage.getConcatenatedMatrix());
          }
          self._renderFrame(context, frame.mask, maskMatrix, viewport, new Canvas2DStageRendererState(state.options, true));
          self._renderFrame(context, frame, matrix, viewport, new Canvas2DStageRendererState(state.options, false, frame));
          context.restore();
          return VisitorFlags.Skip;
        }

        if (flags & FrameFlags.EnterClip) {
          context.save();
          context.enterBuildingClippingRegion();
          self._renderFrame(context, frame, matrix, MAX_VIEWPORT, new Canvas2DStageRendererState(state.options, true));
          context.leaveBuildingClippingRegion();
          return;
        } else if (flags & FrameFlags.LeaveClip) {
          context.restore();
          return;
        }

        // Return early if the bounds are not within the viewport.
        if (!viewport.intersectsTransformedAABB(bounds, matrix)) {
          return VisitorFlags.Skip;
        }

        if (frame.pixelSnapping === PixelSnapping.Always || state.options.snapToDevicePixels) {
          matrix.snap();
        }

        context.imageSmoothingEnabled =
          frame.smoothing === Smoothing.Always || state.options.imageSmoothing;

        context.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);

        var concatenatedColorMatrix = frame.getConcatenatedColorMatrix();


        if (concatenatedColorMatrix.isIdentity()) {
          context.globalAlpha = 1;
          context.globalColorMatrix = null;
        } else if (concatenatedColorMatrix.hasOnlyAlphaMultiplier()) {
          context.globalAlpha = concatenatedColorMatrix.alphaMultiplier;
          context.globalColorMatrix = null;
        } else {
          context.globalAlpha = 1;
          context.globalColorMatrix = concatenatedColorMatrix;
        }

        if (flags & FrameFlags.IsMask && !state.clipRegion) {
          return VisitorFlags.Skip;
        }

        var boundsAABB = frame.getBounds().clone();
        matrix.transformRectangleAABB(boundsAABB);
        boundsAABB.snap();

        if (frame !== root && (state.options.blending || state.options.filters)) {
          context.globalCompositeOperation = self._getCompositeOperation(frame.blendMode);
          if (frame.blendMode !== BlendMode.Normal || frame.filters.length) {
            applyFilters(context, frame.filters);
            var result = self._renderToSurfaceRegion(frame, matrix, viewport);
            var surfaceRegion = result.surfaceRegion;
            var surfaceRegionBounds = result.surfaceRegionBounds;
            var clippedBounds = result.clippedBounds;
            var region = surfaceRegion.region;
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.drawImage (
              surfaceRegion.surface.canvas,
              surfaceRegionBounds.x,
              surfaceRegionBounds.y,
              surfaceRegionBounds.w,
              surfaceRegionBounds.h,
              clippedBounds.x,
              clippedBounds.y,
              surfaceRegionBounds.w,
              surfaceRegionBounds.h
            );
            removeFilters(context);
            surfaceRegion.surface.free(surfaceRegion);
            return VisitorFlags.Skip;
          }
        }

        if (frame instanceof Shape) {
          frame._previouslyRenderedAABB = boundsAABB;
          self._renderShape(context, <Shape>frame, matrix, viewport, state);
        } else if (frame instanceof ClipRectangle) {
          var clipRectangle = <ClipRectangle>frame;
          context.save();
          context.beginPath();
          context.rect(bounds.x, bounds.y, bounds.w, bounds.h);
          context.clip();
          boundsAABB.intersect(viewport);

          if (!frame._hasFlags(FrameFlags.Transparent)) {
            // Fill Background
            context.fillStyle = clipRectangle.color.toCSSStyle();
            context.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
          }

          self._renderFrame(context, frame, matrix, boundsAABB, state, true);
          context.restore();
          return VisitorFlags.Skip;
        } else if (state.options.paintBounds && frame instanceof FrameContainer) {
          var bounds = frame.getBounds().clone();
          context.strokeStyle = ColorStyle.LightOrange;
          context.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
        }
        return VisitorFlags.Continue;
      }, matrix, FrameFlags.Empty, VisitorFlags.Clips);
    }

    private _getCompositeOperation(blendMode: BlendMode): string {
      // TODO:

      // These Flash blend modes have no canvas equivalent:
      // - blendModeClass.SUBTRACT
      // - blendModeClass.INVERT
      // - blendModeClass.SHADER
      // - blendModeClass.ADD

      // These blend modes are actually Porter-Duff compositing operators.
      // The backdrop is the nearest parent with blendMode set to LAYER.
      // When there is no LAYER parent, they are ignored (treated as NORMAL).
      // - blendModeClass.ALPHA (destination-in)
      // - blendModeClass.ERASE (destination-out)
      // - blendModeClass.LAYER [defines backdrop]

      var compositeOp: string = "source-over";
      switch (blendMode) {
        case BlendMode.Multiply:   compositeOp = "multiply";   break;
        case BlendMode.Screen:     compositeOp = "screen";     break;
        case BlendMode.Lighten:    compositeOp = "lighten";    break;
        case BlendMode.Darken:     compositeOp = "darken";     break;
        case BlendMode.Difference: compositeOp = "difference"; break;
        case BlendMode.Overlay:    compositeOp = "overlay";    break;
        case BlendMode.HardLight:  compositeOp = "hard-light"; break;
      }
      return compositeOp;
    }
  }
}
