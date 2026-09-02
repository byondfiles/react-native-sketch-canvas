'use strict';

import memoize from 'memoize-one';
import React from 'react';
import { PanResponder, PixelRatio, Platform, processColor } from 'react-native';
import { requestPermissions } from './handlePermissions';
import {
  type SketchCanvasProps,
  type CanvasText,
  type PathData,
  type Path,
  OnChangeEventType,
} from './types';

import ReactNativeSketchCanvasView, {
  Commands,
} from './specs/SketchCanvasNativeComponent';

import RNSketchModule from './specs/NativeSketchCanvasModule';

type CanvasState = {
  text: any;
};

type ComponentRef = InstanceType<typeof ReactNativeSketchCanvasView>;

class SketchCanvas extends React.Component<SketchCanvasProps, CanvasState> {
  ref = React.createRef<ComponentRef>();

  static defaultProps = {
    style: null,
    strokeColor: '#000000',
    strokeWidth: 3,
    onLayout: ()=> {},
    onPathsChange: () => {},
    onStrokeStart: (_x: number, _y: number) => {},
    onStrokeChanged: () => {},
    onStrokeEnd: () => {},
    onSketchSaved: () => {},
    onPinchStart: () => {},
    onGenerateBase64: () => {},
    user: null,

    touchEnabled: true,

    text: null,
    localSourceImage: null,

    permissionDialogTitle: '',
    permissionDialogMessage: '',
    canvasScale: 1,
    minTravelToDraw: 12,
    minDelayToDraw: 80,
  };

  _pathsToProcess: Path[];
  _paths: Path[];
  _path: PathData | null;
  _handle: any;
  _screenScale: number;
  _offset: { x: number; y: number };
  _startPoint: { x: number; y: number };
  _pathStarted: boolean;
  _multiTouch: boolean;
  _travelled: boolean;
  _grantedAt: number;
  // Points made before the gesture is known to be a single finger draw. They
  // are replayed to the native canvas the moment it is.
  _pendingPoints: { x: number; y: number }[];
  _size: { width: number; height: number };
  _initialized: boolean;
  panResponder: any;

  state = {
    text: null,
  };
  static MAIN_BUNDLE: any;
  static DOCUMENT: any;
  static LIBRARY: any;
  static CACHES: any;

  constructor(props: SketchCanvasProps) {
    super(props);
    this._pathsToProcess = [];
    this._paths = [];
    this._path = null;
    this._handle = null;
    this._screenScale = Platform.OS === 'ios' ? 1 : PixelRatio.get();
    this._offset = { x: 0, y: 0 };
    this._startPoint = { x: 0, y: 0 };
    this._pathStarted = false;
    this._multiTouch = false;
    this._travelled = false;
    this._grantedAt = 0;
    this._pendingPoints = [];
    this._size = { width: 0, height: 0 };
    this._initialized = false;

    this.panResponder = PanResponder.create({
      // Ask to be the responder. Nothing is captured on purpose: capturing
      // takes the touch away from ancestors before they can react, which stops
      // a surrounding scroll view from ever recognising a pinch.
      onStartShouldSetPanResponder: (evt, _gestureState) => {
        if (evt.nativeEvent.touches.length > 1) {
          // This is the earliest moment a second finger is visible, earlier
          // than any move event or the terminate that follows. Clearing the
          // path here keeps a pinch from flickering whatever the first finger
          // managed to draw while it was still alone.
          this._abortPath();

          // after the abort, because discarding resets this flag
          this._multiTouch = true;

          // two fingers are a zoom, leave the gesture alone
          this.props.onPinchStart?.();
          return false;
        }

        return true;
      },
      onStartShouldSetPanResponderCapture: (_evt, _gestureState) => false,
      onMoveShouldSetPanResponder: (_evt, _gestureState) => false,
      onMoveShouldSetPanResponderCapture: (_evt, _gestureState) => false,

      onPanResponderGrant: (evt, gestureState) => {
        if (!this.props.touchEnabled) {
          return;
        }
        const e = evt.nativeEvent;
        this._offset = { x: e.pageX - e.locationX, y: e.pageY - e.locationY };
        this._startPoint = { x: gestureState.x0 - this._offset.x, y: gestureState.y0 - this._offset.y };
        this._pathStarted = false;
        this._travelled = false;
        this._pendingPoints = [];
        this._grantedAt = Date.now();
        this._multiTouch = e.touches.length > 1;
        this._path = {
          id: parseInt(String(Math.random() * 100000000), 10),
          color: this.props.strokeColor,
          width: this.props.strokeWidth,
          data: [],
        };
        // The path is only handed to the native side once we know this gesture
        // is a single finger draw. Drawing it here left a dot behind whenever
        // the second finger of a pinch arrived, because the zoom recognizer can
        // take the gesture away before any two finger move event reaches js.
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (!this.props.touchEnabled) {
          return;
        }
        const e = _evt.nativeEvent;

        if (e.touches.length > 1) {
          this._multiTouch = true;
          return this.props.onPinchStart?.();
        }

        if (this._multiTouch) {
          return;
        }

        const currentX = gestureState.moveX - this._offset.x;
        const currentY = gestureState.moveY - this._offset.y;

        if (!this._travelled && this._travelledEnough(currentX, currentY)) {
          this._travelled = true;
        }

        const mappedX = (currentX - this._startPoint.x) / (this.props.canvasScale || 1) + this._startPoint.x;
        const mappedY = (currentY - this._startPoint.y) / (this.props.canvasScale || 1) + this._startPoint.y;

        if (!this._pathStarted) {
          // Hold on to the point. A pinch that starts now costs nothing to undo
          // because the canvas never saw any of this.
          this._pendingPoints.push({ x: mappedX, y: mappedY });

          if (!this._travelled || !this._waitedLongEnough()) {
            return;
          }

          this._beginPath();
          return;
        }

        this._sendPoint(mappedX, mappedY);
      },
      onPanResponderRelease: (_evt, _gestureState) => {
        this._endGesture(false);
      },

      onPanResponderTerminate: (_evt, _gestureState) => {
        // Something else took the gesture over, a zoom recognizer for instance.
        this._endGesture(true);
      },

      onShouldBlockNativeResponder: (_evt, _gestureState) => {
        return true;
      },
    });
  }

  // Hands the pending path to the native side. Called on the first single
  // finger move, or on release for a tap that never moved.
  _beginPath = () => {
    if (this._pathStarted || !this._path || !this.ref.current) {
      return;
    }

    this._pathStarted = true;

    Commands.newPath(
      this.ref.current,
      this._path.id,
      processColor(this._path.color) as number,
      this._path.width ? this._path.width * this._screenScale : 0
    );

    Commands.addPoint(
      this.ref.current,
      parseFloat(
        (Number(this._startPoint.x.toFixed(2)) * this._screenScale).toString()
      ),
      parseFloat(
        (Number(this._startPoint.y.toFixed(2)) * this._screenScale).toString()
      )
    );

    const x = parseFloat(this._startPoint.x.toFixed(2)),
      y = parseFloat(this._startPoint.y.toFixed(2));
    this._path.data.push(`${x},${y}`);
    this.props.onStrokeStart?.(x, y);

    // Replay what was made while the gesture was still unconfirmed, so the
    // stroke appears whole instead of starting where the waiting ended.
    const pending = this._pendingPoints;
    this._pendingPoints = [];
    pending.forEach((point) => this._sendPoint(point.x, point.y));
  };

  _sendPoint = (mappedX: number, mappedY: number) => {
    if (!this._path || !this.ref.current) {
      return;
    }

    Commands.addPoint(
      this.ref.current,
      parseFloat((Number(mappedX.toFixed(2)) * this._screenScale).toString()),
      parseFloat((Number(mappedY.toFixed(2)) * this._screenScale).toString())
    );

    const x = parseFloat(mappedX.toFixed(2)),
      y = parseFloat(mappedY.toFixed(2));
    this._path.data.push(`${x},${y}`);
    this.props.onStrokeChanged?.(x, y);
  };

  _waitedLongEnough = () =>
    Date.now() - this._grantedAt >= (this.props.minDelayToDraw ?? 80);

  _travelledEnough = (currentX: number, currentY: number) => {
    const dx = currentX - this._startPoint.x;
    const dy = currentY - this._startPoint.y;

    // Screen space on purpose. The jitter this filters out is a physical finger
    // movement and does not shrink when the view is zoomed in.
    return Math.sqrt(dx * dx + dy * dy) >= (this.props.minTravelToDraw ?? 12);
  };

  // Removes a path the native side already received.
  _abortPath = () => {
    if (this._path && this._pathStarted && this.ref.current) {
      Commands.deletePath(this.ref.current, this._path.id);
    }

    this._discardPath();
  };

  _endGesture = (terminated: boolean) => {
    if (!this._pathStarted) {
      // A tap that never moved draws nothing, which is what the canvas did
      // before the rewrite to this library. A stroke that was over before the
      // wait elapsed does get drawn, otherwise a quick flick would vanish.
      if (terminated || this._multiTouch || !this._travelled) {
        return this._discardPath();
      }

      this._beginPath();
      return this._handleStrokeEnd();
    }

    // Someone else took the gesture over, a zoom recognizer for instance, so
    // whatever was scratched so far was never meant as a stroke.
    if (terminated) {
      return this._abortPath();
    }

    this._handleStrokeEnd();
  };

  // Throws the pending path away without touching the native canvas, which
  // never received it.
  _discardPath = () => {
    this._path = null;
    this._pathStarted = false;
    this._multiTouch = false;
    this._travelled = false;
    this._pendingPoints = [];
  };

  _handleStrokeEnd = () => {
    if (!this.props.touchEnabled) {
      return;
    }

    if (this._path) {
      this.props.onStrokeEnd?.({
        path: this._path,
        size: this._size,
        drawer: this.props.user,
      });
      this._paths.push({
        path: this._path,
        size: this._size,
        drawer: this.props.user,
      });
    }

    if (this.ref.current) {
      Commands.endPath(this.ref.current);
    }

    this._pathStarted = false;
    this._multiTouch = false;
  };

  _processText(text: any) {
    text &&
      text.forEach(
        (t: { fontColor: any }) => (t.fontColor = processColor(t.fontColor))
      );
    return text;
  }

  getProcessedText = memoize((text: CanvasText[] | undefined) => {
    const textCopy = text ? text.map((t) => Object.assign({}, t)) : null;

    return this._processText(textCopy);
  });

  clear() {
    this._paths = [];
    this._path = null;

    if (this.ref.current) {
      Commands.clear(this.ref.current);
    }
  }

  undo() {
    let lastId = -1;
    this._paths.forEach(
      (d: any) => (lastId = d.drawer === this.props.user ? d.path.id : lastId)
    );
    if (lastId >= 0) {
      this.deletePath(lastId);
    }
    return lastId;
  }

  addPath(data: Path) {
    if (this._initialized) {
      if (
        this._paths.filter((p: Path) => p.path.id === data.path.id).length === 0
      ) {
        this._paths.push(data);
      }
      const pathData = data.path.data.map((p: any) => {
        const coor = p.split(',').map((pp: any) => parseFloat(pp).toFixed(2));
        return `${
          (coor[0] * this._screenScale * this._size.width) / data.size.width
        },${
          (coor[1] * this._screenScale * this._size.height) / data.size.height
        }`;
      });

      if (this.ref.current) {
        Commands.addPath(
          this.ref.current,
          data.path.id,
          processColor(data.path.color) as number,
          data.path.width ? data.path.width * this._screenScale : 0,
          pathData
        );
      }
    } else {
      this._pathsToProcess.filter((p: Path) => p.path.id === data.path.id)
        .length === 0 && this._pathsToProcess.push(data);
    }
  }

  setInitialPaths(initialPaths: Path[]) {
    if (
      !this._initialized ||
      !this.ref.current ||
      !initialPaths ||
      initialPaths.length === 0
    ) {
      return;
    }

    // Convert paths to the format expected by native addInitialPaths command
    const pathsArray = initialPaths.map((data: Path) => {
      const pathData = data.path.data.map((p: any) => {
        const coor = p.split(',').map((pp: any) => parseFloat(pp).toFixed(2));
        return `${
          (coor[0] * this._screenScale * this._size.width) / data.size.width
        },${
          (coor[1] * this._screenScale * this._size.height) / data.size.height
        }`;
      });

      return {
        pathId: data.path.id,
        color: processColor(data.path.color) as number,
        width: data.path.width ? data.path.width * this._screenScale : 0,
        points: pathData,
      };
    });

    // Add valid paths to internal tracking
    initialPaths.forEach((data: Path) => {
      if (
        this._paths.filter((p: Path) => p.path.id === data.path.id).length === 0
      ) {
        this._paths.push(data);
      }
    });

    // Call native batch operation
    Commands.addInitialPaths(this.ref.current, pathsArray);
  }

  deletePath(id: any) {
    this._paths = this._paths.filter((p) => p.path.id !== id);

    if (this.ref.current) {
      Commands.deletePath(this.ref.current, id);
    }
  }

  save(
    imageType: string,
    transparent: boolean,
    folder: string,
    filename: string,
    includeImage: boolean,
    includeText: boolean,
    cropToImageSize: boolean
  ) {
    if (this.ref.current) {
      Commands.save(
        this.ref.current,
        imageType,
        folder,
        filename,
        transparent,
        includeImage,
        includeText,
        cropToImageSize
      );
    }
  }

  getPaths() {
    return this._paths;
  }

  getBase64(
    imageType: string,
    transparent: boolean,
    includeImage: boolean,
    includeText: boolean,
    cropToImageSize: boolean
  ) {
    if (Platform.OS === 'ios') {
      if (this.ref.current) {
        Commands.transferToBase64(
          this.ref.current,
          imageType,
          transparent,
          includeImage,
          includeText,
          cropToImageSize
        );
      }
    } else {
      if (this.ref.current) {
        Commands.transferToBase64(
          this.ref.current,
          imageType,
          transparent,
          includeImage,
          includeText,
          cropToImageSize
        );
      }
    }
  }

  async componentDidMount() {
    await requestPermissions(
      this.props.permissionDialogTitle || '',
      this.props.permissionDialogMessage || ''
    );
  }

  render() {
    return (
      <ReactNativeSketchCanvasView
        ref={this.ref}
        style={this.props.style}
        onLayout={(e: any) => {
          this._size = {
            width: e.nativeEvent.layout.width,
            height: e.nativeEvent.layout.height,
          };
          this._initialized = true;

          // Handle any queued paths using individual operations
          this._pathsToProcess.length > 0 &&
            this._pathsToProcess.forEach((p) => this.addPath(p));
          this.props.onLayout?.(e)
        }}
        {...this.panResponder.panHandlers}
        onChange={(e: any) => {
          const { eventType, pathsUpdate, success, path } = e.nativeEvent || {};

          const isSuccess = success !== undefined;
          const isSave = eventType === OnChangeEventType.Save;
          const isPathsUpdate = eventType === OnChangeEventType.PathsUpdate;

          if (!isSave && isPathsUpdate) {
            this.props.onPathsChange?.(pathsUpdate);
          } else if (isSave) {
            this.props.onSketchSaved?.(success, path);
          } else if (isSuccess) {
            this.props.onSketchSaved?.(success, '');
          }
        }}
        onGenerateBase64={(e: any) => {
          this.props.onGenerateBase64?.(e.nativeEvent || {});
        }}
        onCanvasReady={() => {
          this.props.onCanvasReady?.();

          // Handle initial paths prop using batch operation
          if (this.props.initialPaths && this.props.initialPaths.length > 0) {
            this.setInitialPaths(this.props.initialPaths);
          }
        }}
        onInitialPathsLoaded={(e: any) => {
          this.props.onInitialPathsLoaded?.(e.nativeEvent || {});
        }}
        localSourceImage={this.props.localSourceImage}
        permissionDialogTitle={this.props.permissionDialogTitle}
        permissionDialogMessage={this.props.permissionDialogMessage}
        text={this.getProcessedText(this.props.text)}
      />
    );
  }
}

SketchCanvas.MAIN_BUNDLE = RNSketchModule.getConstants().MainBundlePath;
SketchCanvas.DOCUMENT = RNSketchModule.getConstants().NSDocumentDirectory;
SketchCanvas.LIBRARY = RNSketchModule.getConstants().NSLibraryDirectory;
SketchCanvas.CACHES = RNSketchModule.getConstants().NSCachesDirectory;

export default SketchCanvas;
