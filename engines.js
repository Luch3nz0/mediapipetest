const PHASE_COPY = {
  WAITING_FOR_START_POSITION: "Setup",
  READY: "Ready",
  DESCENDING: "Descending",
  BOTTOM: "Bottom",
  ASCENDING: "Ascending",
  REST: "Rest",
  SESSION_COMPLETE: "Complete"
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function average(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function toPoint(landmarks, index) {
  const source = landmarks[index] || {}
  return {
    x: source.x != null ? source.x : 0,
    y: source.y != null ? source.y : 0,
    z: source.z != null ? source.z : 0,
    visibility: source.visibility != null ? source.visibility : source.presence != null ? source.presence : 1
  }
}

function vec(a, b) {
  return { x: b.x - a.x, y: b.y - a.y, visibility: 1 }
}

function norm(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y)
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y
}

function distance(a, b) {
  return norm(vec(a, b))
}

function angleABC(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y, visibility: 1 }
  const bc = { x: c.x - b.x, y: c.y - b.y, visibility: 1 }
  const denom = norm(ba) * norm(bc)
  if (denom === 0) return 0
  const cosine = clamp(dot(ba, bc) / denom, -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

function angleToVertical(from, to) {
  const segment = vec(from, to)
  const vertical = { x: 0, y: -1, visibility: 1 }
  const denom = norm(segment) * norm(vertical)
  if (denom === 0) return 0
  const cosine = clamp(dot(segment, vertical) / denom, -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

function angleBetweenSegments(a1, a2, b1, b2) {
  const va = vec(a1, a2)
  const vb = vec(b1, b2)
  const denom = norm(va) * norm(vb)
  if (denom === 0) return 0
  const cosine = clamp(Math.abs(dot(va, vb)) / denom, -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

function inFrame(point) {
  return point.x >= 0.02 && point.x <= 0.98 && point.y >= 0.02 && point.y <= 0.98
}

export class VoiceCoach {
  constructor() {
    this.lastSpokenAt = new Map()
    this.lastAnySpokenAt = -Infinity
    this.muted = false
  }

  setMuted(nextMuted) {
    this.muted = nextMuted
    if (nextMuted) this.stop()
  }

  speak({ key, message, minIntervalMs = 2400, interrupt = false }) {
    if (this.muted || !("speechSynthesis" in window) || message.trim() === "") return false

    const now = performance.now()
    const previous = this.lastSpokenAt.has(key) ? this.lastSpokenAt.get(key) : -Infinity

    if (now - previous < minIntervalMs) return false
    if (!interrupt && now - this.lastAnySpokenAt < 2400) return false
    if (!interrupt && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) return false

    if (interrupt) window.speechSynthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(message)
    utterance.lang = "en-US"
    utterance.rate = 1
    utterance.pitch = 1

    window.speechSynthesis.speak(utterance)
    this.lastSpokenAt.set(key, now)
    this.lastAnySpokenAt = now
    return true
  }

  stop() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel()
    }
  }
}

const SQUAT_LANDMARK_INDEX = {
  nose: 0,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32
}

const SQUAT_READY_COPY = {
  "turn-sideways": "Turn sideways to the camera.",
  "step-back": "Move back so your full body fits on screen.",
  "adjust-position": "Adjust your position until one side is clearly visible.",
  "stand-tall": "Stand tall and get ready.",
  "move-into-frame": "Move until your full body is visible."
}

export class SquatSessionEngine {
  constructor(protocol) {
    this.protocol = protocol
    this.smoothing = {
      kneeAngle: [],
      hipAngle: [],
      ankleAngle: [],
      torsoLean: [],
      torsoTibiaDelta: []
    }
    this.phase = "WAITING_FOR_START_POSITION"
    this.setNumber = 1
    this.repInSet = 0
    this.totalReps = 0
    this.validReps = 0
    this.invalidReps = 0
    this.results = []
    this.readyStableSince = null
    this.repStartedAt = null
    this.bottomHoldSince = null
    this.restStartedAt = null
    this.needsSetStartCheck = true
    this.readyBaseline = null
    this.currentRep = this.createRepTracker()
    this.lastMetrics = null
    this.lastHipY = null
    this.restGetReadyAnnounced = false
    this.lastVoiceAt = new Map()
    this.lastAnyVoiceAt = -Infinity
  }

  getSnapshot() {
    return this.buildSnapshot(null, this.messageForState(null))
  }

  tickWithoutPose(timestampMs) {
    const events = []

    if (this.phase === "REST") {
      this.handleRestTick(timestampMs, null, events)
      return {
        snapshot: this.buildSnapshot(null, this.messageForState(null)),
        events
      }
    }

    if (this.needsSetStartCheck) {
      if (this.phase !== "WAITING_FOR_START_POSITION" && this.phase !== "SESSION_COMPLETE") {
        this.phase = "WAITING_FOR_START_POSITION"
        this.clearMovementState()
      }

      this.readyStableSince = null
      this.maybeSpeak(events, "move-into-frame", SQUAT_READY_COPY["move-into-frame"], timestampMs, 2600)

      return {
        snapshot: this.buildSnapshot(null, SQUAT_READY_COPY["move-into-frame"]),
        events
      }
    }

    return {
      snapshot: this.buildSnapshot(null, this.messageForState(null)),
      events
    }
  }

  processLandmarks(landmarks, timestampMs) {
    const frame = this.analyzeFrame(landmarks)
    const events = []

    if (this.phase === "REST") {
      this.handleRestTick(timestampMs, frame, events)
      return {
        snapshot: this.buildSnapshot(frame, this.messageForState(frame)),
        events
      }
    }

    if (this.needsSetStartCheck && (!frame.orientation.accepted || !frame.startPostureOk)) {
      this.phase = "WAITING_FOR_START_POSITION"
      this.readyStableSince = null
      this.clearMovementState()
      this.maybeSpeak(events, frame.orientation.reason, SQUAT_READY_COPY[frame.orientation.reason], timestampMs, 2400)
      this.captureTopMetrics(frame)
      return {
        snapshot: this.buildSnapshot(frame, SQUAT_READY_COPY[frame.orientation.reason]),
        events
      }
    }

    switch (this.phase) {
      case "WAITING_FOR_START_POSITION":
        if (!this.needsSetStartCheck) {
          this.phase = "READY"
          this.captureTopMetrics(frame)
          break
        }

        if (this.readyStableSince === null) {
          this.readyStableSince = timestampMs
        }

        if (timestampMs - this.readyStableSince >= 700) {
          this.phase = "READY"
          this.needsSetStartCheck = false
          this.captureTopMetrics(frame)
          this.maybeSpeak(events, "start-performing", "Start performing the exercise.", timestampMs, 900)
        }
        break

      case "READY":
        if (this.shouldStartDescending(frame)) {
          this.phase = "DESCENDING"
          this.repStartedAt = timestampMs
          this.currentRep = this.createRepTracker()
        } else if (this.isTopPosition(frame)) {
          this.captureTopMetrics(frame)
        }
        break

      case "DESCENDING":
      case "BOTTOM":
      case "ASCENDING":
        this.trackRepFrame(frame, timestampMs, events)
        break

      default:
        break
    }

    this.lastMetrics = frame.metrics
    this.lastHipY = frame.sidePoints.hip.y

    return {
      snapshot: this.buildSnapshot(frame, this.messageForState(frame)),
      events
    }
  }

  createRepTracker() {
    return {
      depthReached: false,
      heelErrorFrames: 0,
      leanErrorFrames: 0,
      lowestKneeAngle: 180,
      maxTorsoLean: 0,
      maxHeelLift: 0,
      feedback: new Set()
    }
  }

  clearMovementState() {
    this.repStartedAt = null
    this.bottomHoldSince = null
    this.currentRep = this.createRepTracker()
  }

  captureTopMetrics(frame) {
    this.readyBaseline = {
      kneeAngle: frame.metrics.kneeAngle,
      hipAngle: frame.metrics.hipAngle,
      heelY: frame.sidePoints.heel.y
    }
    this.lastMetrics = frame.metrics
    this.lastHipY = frame.sidePoints.hip.y
  }

  shouldStartDescending(frame) {
    const baselineKnee =
      this.readyBaseline && this.readyBaseline.kneeAngle != null ? this.readyBaseline.kneeAngle : 165
    const descendThreshold = Math.min(baselineKnee - 18, 145)
    return frame.metrics.kneeAngle <= descendThreshold
  }

  isTopPosition(frame) {
    return frame.metrics.kneeAngle >= 150 && frame.metrics.torsoLean <= 60
  }

  isMovingUp(frame) {
    if (this.lastMetrics === null) return false
    const kneeOpening = frame.metrics.kneeAngle >= this.lastMetrics.kneeAngle + 2
    const hipRising = this.lastHipY !== null && frame.sidePoints.hip.y < this.lastHipY - 0.0015
    return kneeOpening || hipRising
  }

  trackRepFrame(frame, timestampMs, events) {
    const heelLiftThreshold = frame.bodyHeight * 0.03
    const excessiveLean = frame.metrics.torsoLean > 60
    const heelLifted = frame.metrics.effectiveHeelLift > heelLiftThreshold

    this.currentRep.depthReached =
      this.currentRep.depthReached || frame.metrics.reachedDepth || frame.metrics.kneeAngle <= 110
    this.currentRep.lowestKneeAngle = Math.min(this.currentRep.lowestKneeAngle, frame.metrics.kneeAngle)
    this.currentRep.maxTorsoLean = Math.max(this.currentRep.maxTorsoLean, frame.metrics.torsoLean)
    this.currentRep.maxHeelLift = Math.max(this.currentRep.maxHeelLift, frame.metrics.effectiveHeelLift)

    if (excessiveLean) {
      this.currentRep.leanErrorFrames += 1
      this.currentRep.feedback.add("Lift your chest a little more.")
      this.maybeSpeak(events, "lift-chest", "Lift your chest a little more.", timestampMs, 4200)
    }

    if (heelLifted) {
      this.currentRep.heelErrorFrames += 1
      this.currentRep.feedback.add("Keep your heels on the floor.")
      this.maybeSpeak(events, "keep-heels-down", "Keep your heels on the floor.", timestampMs, 4200)
    }

    if (this.phase === "DESCENDING") {
      if (frame.metrics.kneeAngle <= 110 || this.currentRep.depthReached) {
        this.phase = "BOTTOM"
        this.bottomHoldSince = timestampMs
      }
      return
    }

    if (this.phase === "BOTTOM") {
      if (this.bottomHoldSince !== null && timestampMs - this.bottomHoldSince >= 80 && this.isMovingUp(frame)) {
        this.phase = "ASCENDING"
      }
      return
    }

    if (this.phase === "ASCENDING" && this.isTopPosition(frame)) {
      this.completeRep(frame, timestampMs, events)
    }
  }

  completeRep(frame, timestampMs, events) {
    const repDurationMs = Math.max(0, timestampMs - (this.repStartedAt != null ? this.repStartedAt : timestampMs))
    const depthValid = this.currentRep.depthReached
    const postureValid = this.currentRep.leanErrorFrames <= 6 && this.currentRep.heelErrorFrames <= 5
    const tempoValid = repDurationMs >= 700

    if (!depthValid) {
      this.currentRep.feedback.add("Bend your knees a little more.")
    }

    if (!tempoValid) {
      this.currentRep.feedback.add("Slow down.")
    }

    const depthPenalty = Math.max(0, this.currentRep.lowestKneeAngle - 108) * 2
    const depthScore = clamp(Math.round(100 - depthPenalty), 20, 100)
    const leanPenalty = Math.max(0, this.currentRep.maxTorsoLean - 58) * 1.2
    const heelPenalty = frame.bodyHeight === 0 ? 0 : (this.currentRep.maxHeelLift / frame.bodyHeight) * 240
    const tempoPenalty = tempoValid ? 0 : 10
    const postureScore = clamp(Math.round(100 - leanPenalty - heelPenalty - tempoPenalty), 15, 100)

    const repResult = {
      setNumber: this.setNumber,
      repInSet: this.repInSet + 1,
      depthValid,
      postureValid,
      tempoValid,
      valid: depthValid && postureValid && tempoValid,
      durationMs: repDurationMs,
      depthScore,
      postureScore,
      feedback: Array.from(this.currentRep.feedback)
    }

    this.totalReps += 1
    this.repInSet += 1
    this.results.push(repResult)

    if (repResult.valid) {
      this.validReps += 1
    } else {
      this.invalidReps += 1
    }

    this.maybeSpeak(events, `rep-${this.repInSet}`, String(this.repInSet), timestampMs, 0, true)

    this.clearMovementState()
    this.captureTopMetrics(frame)

    if (this.repInSet >= this.protocol.repsPerSet) {
      if (this.setNumber >= this.protocol.sets) {
        this.phase = "SESSION_COMPLETE"
        this.maybeSpeak(events, "great-job", "Great job.", timestampMs, 0, true)
      } else {
        this.phase = "REST"
        this.setNumber += 1
        this.repInSet = 0
        this.restStartedAt = timestampMs
        this.restGetReadyAnnounced = false
        this.maybeSpeak(events, "rest-time", "Rest time.", timestampMs, 0, true)
      }
      return
    }

    this.phase = "READY"
  }

  handleRestTick(timestampMs, frame, events) {
    if (this.restStartedAt === null) {
      this.restStartedAt = timestampMs
    }

    const remainingMs = Math.max(0, this.protocol.restSeconds * 1000 - (timestampMs - this.restStartedAt))

    if (!this.restGetReadyAnnounced && remainingMs <= 5000) {
      this.restGetReadyAnnounced = true
      this.maybeSpeak(events, "get-ready", "Get ready.", timestampMs, 0)
    }

    if (remainingMs > 0) {
      if (remainingMs <= 5000 && frame && !frame.readyToStart) {
        this.maybeSpeak(events, frame.orientation.reason, SQUAT_READY_COPY[frame.orientation.reason], timestampMs, 2400)
      }
      return
    }

    this.phase = "WAITING_FOR_START_POSITION"
    this.restStartedAt = null
    this.readyStableSince = null
    this.currentRep = this.createRepTracker()
    this.needsSetStartCheck = true

    if (frame && frame.readyToStart) {
      this.readyStableSince = timestampMs
      this.captureTopMetrics(frame)
      this.phase = "READY"
      this.needsSetStartCheck = false
      this.maybeSpeak(events, "start-performing", "Start performing the exercise.", timestampMs, 900)
    }
  }

  maybeSpeak(events, key, message, timestampMs, minIntervalMs = 2000, interrupt = false) {
    const last = this.lastVoiceAt.has(key) ? this.lastVoiceAt.get(key) : -Infinity
    if (timestampMs - last < minIntervalMs) return
    if (!interrupt && timestampMs - this.lastAnyVoiceAt < 3200) return
    if (events.some((event) => event.type === "voice")) return

    this.lastVoiceAt.set(key, timestampMs)
    this.lastAnyVoiceAt = timestampMs
    events.push({ type: "voice", key, message, interrupt })
  }

  analyzeFrame(landmarks) {
    const leftPoints = {
      shoulder: toPoint(landmarks, SQUAT_LANDMARK_INDEX.leftShoulder),
      hip: toPoint(landmarks, SQUAT_LANDMARK_INDEX.leftHip),
      knee: toPoint(landmarks, SQUAT_LANDMARK_INDEX.leftKnee),
      ankle: toPoint(landmarks, SQUAT_LANDMARK_INDEX.leftAnkle),
      heel: toPoint(landmarks, SQUAT_LANDMARK_INDEX.leftHeel),
      footIndex: toPoint(landmarks, SQUAT_LANDMARK_INDEX.leftFootIndex),
      ear: toPoint(landmarks, SQUAT_LANDMARK_INDEX.leftEar)
    }
    const rightPoints = {
      shoulder: toPoint(landmarks, SQUAT_LANDMARK_INDEX.rightShoulder),
      hip: toPoint(landmarks, SQUAT_LANDMARK_INDEX.rightHip),
      knee: toPoint(landmarks, SQUAT_LANDMARK_INDEX.rightKnee),
      ankle: toPoint(landmarks, SQUAT_LANDMARK_INDEX.rightAnkle),
      heel: toPoint(landmarks, SQUAT_LANDMARK_INDEX.rightHeel),
      footIndex: toPoint(landmarks, SQUAT_LANDMARK_INDEX.rightFootIndex),
      ear: toPoint(landmarks, SQUAT_LANDMARK_INDEX.rightEar)
    }

    const leftMeanVisibility = average([
      leftPoints.shoulder.visibility,
      leftPoints.hip.visibility,
      leftPoints.knee.visibility,
      leftPoints.ankle.visibility,
      leftPoints.heel.visibility,
      leftPoints.footIndex.visibility
    ])
    const rightMeanVisibility = average([
      rightPoints.shoulder.visibility,
      rightPoints.hip.visibility,
      rightPoints.knee.visibility,
      rightPoints.ankle.visibility,
      rightPoints.heel.visibility,
      rightPoints.footIndex.visibility
    ])

    const trackedSide = leftMeanVisibility >= rightMeanVisibility ? "left" : "right"
    const sidePoints = trackedSide === "left" ? leftPoints : rightPoints
    const farPoints = trackedSide === "left" ? rightPoints : leftPoints
    const trackedSideMean = trackedSide === "left" ? leftMeanVisibility : rightMeanVisibility
    const farSideMean = trackedSide === "left" ? rightMeanVisibility : leftMeanVisibility

    const nose = toPoint(landmarks, SQUAT_LANDMARK_INDEX.nose)
    const bodyHeight = Math.abs(nose.y - average([leftPoints.ankle.y, rightPoints.ankle.y]))
    const shoulderWidthRatio = bodyHeight === 0 ? 0 : Math.abs(leftPoints.shoulder.x - rightPoints.shoulder.x) / bodyHeight

    const requiredVisible =
      trackedSideMean >= 0.7 &&
      [
        sidePoints.shoulder,
        sidePoints.hip,
        sidePoints.knee,
        sidePoints.ankle,
        sidePoints.heel,
        sidePoints.footIndex
      ].every((point) => point.visibility >= 0.65)

    const fullBodyVisible =
      inFrame(nose) &&
      inFrame(sidePoints.shoulder) &&
      inFrame(sidePoints.knee) &&
      inFrame(sidePoints.ankle) &&
      inFrame(sidePoints.heel) &&
      inFrame(sidePoints.footIndex)

    let reason = "move-into-frame"

    if (!fullBodyVisible) {
      reason = "step-back"
    } else if (shoulderWidthRatio > 0.18) {
      reason = "turn-sideways"
    } else if (!requiredVisible || trackedSideMean - farSideMean < 0.02) {
      reason = "adjust-position"
    }

    const orientationAccepted =
      requiredVisible &&
      fullBodyVisible &&
      shoulderWidthRatio >= 0.03 &&
      shoulderWidthRatio <= 0.18 &&
      (trackedSideMean - farSideMean >= 0.08 || shoulderWidthRatio <= 0.12)

    const kneeAngle = this.smooth("kneeAngle", angleABC(sidePoints.hip, sidePoints.knee, sidePoints.ankle))
    const hipAngle = this.smooth("hipAngle", angleABC(sidePoints.shoulder, sidePoints.hip, sidePoints.knee))
    const ankleAngle = this.smooth("ankleAngle", angleABC(sidePoints.knee, sidePoints.ankle, sidePoints.footIndex))
    const torsoLean = this.smooth("torsoLean", angleToVertical(sidePoints.hip, sidePoints.shoulder))
    const torsoTibiaDelta = this.smooth(
      "torsoTibiaDelta",
      angleBetweenSegments(sidePoints.hip, sidePoints.shoulder, sidePoints.ankle, sidePoints.knee)
    )

    const baselineHeelY =
      this.readyBaseline && this.readyBaseline.heelY != null ? this.readyBaseline.heelY : sidePoints.heel.y
    const effectiveHeelLift = baselineHeelY - sidePoints.heel.y
    const depthTolerance = bodyHeight * 0.025
    const reachedDepth = kneeAngle <= 95 || sidePoints.hip.y >= sidePoints.knee.y - depthTolerance
    const startPostureOk = kneeAngle >= 155 && hipAngle >= 150 && torsoLean <= 20

    if (orientationAccepted && !startPostureOk) {
      reason = "stand-tall"
    }

    return {
      trackedSide,
      sidePoints,
      farPoints,
      bodyHeight,
      orientation: {
        accepted: orientationAccepted,
        reason,
        trackedSide,
        fullBodyVisible,
        shoulderWidthRatio
      },
      startPostureOk,
      readyToStart: orientationAccepted && startPostureOk,
      metrics: {
        kneeAngle,
        hipAngle,
        ankleAngle,
        torsoLean,
        torsoTibiaDelta,
        effectiveHeelLift,
        reachedDepth,
        orientationAccepted,
        bodyHeight,
        shoulderWidthRatio
      }
    }
  }

  smooth(key, rawValue) {
    const bucket = this.smoothing[key]
    bucket.push(rawValue)
    if (bucket.length > 5) bucket.shift()
    return average(bucket)
  }

  buildSnapshot(frame, coachMessage) {
    const depthScore =
      this.results.length === 0
        ? 0
        : Math.round(this.results.reduce((sum, result) => sum + result.depthScore, 0) / this.results.length)
    const postureScore =
      this.results.length === 0
        ? 0
        : Math.round(this.results.reduce((sum, result) => sum + result.postureScore, 0) / this.results.length)
    const restRemainingMs =
      this.phase === "REST" && this.restStartedAt !== null
        ? Math.max(0, this.protocol.restSeconds * 1000 - (performance.now() - this.restStartedAt))
        : 0

    return {
      phase: this.phase,
      phaseLabel: PHASE_COPY[this.phase],
      setNumber: this.setNumber,
      repInSet: this.repInSet,
      totalReps: this.totalReps,
      validReps: this.validReps,
      invalidReps: this.invalidReps,
      depthScore,
      postureScore,
      restRemainingMs,
      orientationAccepted: frame ? frame.orientation.accepted : false,
      fullBodyVisible: frame ? frame.orientation.fullBodyVisible : false,
      startPostureOk: frame ? frame.startPostureOk : false,
      positionReady: frame ? frame.readyToStart : false,
      trackedSide: frame ? frame.trackedSide : null,
      coachMessage,
      metrics: frame ? frame.metrics : null,
      results: this.results
    }
  }

  messageForState(frame) {
    if (this.phase === "REST") {
      return "Rest time. Breathe, reset, and get ready for the next set."
    }
    if (this.phase === "READY") {
      return "Start performing the exercise."
    }
    if (this.phase === "DESCENDING") {
      return "Control the descent."
    }
    if (this.phase === "BOTTOM") {
      return "Hold the bottom for a beat."
    }
    if (this.phase === "ASCENDING") {
      return "Drive up and stand tall."
    }
    if (this.phase === "SESSION_COMPLETE") {
      return "Great job."
    }

    return SQUAT_READY_COPY[frame ? frame.orientation.reason : "move-into-frame"]
  }
}

const PUSHUP_LANDMARK_INDEX = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftHip: 23,
  rightHip: 24,
  leftAnkle: 27,
  rightAnkle: 28
}

const PUSHUP_READY_COPY = {
  "adjust-position": "Keep your whole side visible in the front camera.",
  "move-into-frame": "Keep your whole side visible in the front camera.",
  "turn-sideways": "Turn into a clear side profile to the front camera.",
  "pushup-position": "Face down, lock your arms, and line up your shoulders, hips, and ankles."
}

const PUSHUP_SIDE_SWITCH_MARGIN = 0.03
const PUSHUP_READY_ELBOW_MIN = 148
const PUSHUP_READY_BODY_MIN = 155
const PUSHUP_SIDE_VIEW_RATIO_MAX = 0.32
const PUSHUP_TRACKED_SIDE_MIN_VISIBILITY = 0.54
const PUSHUP_POINT_MIN_VISIBILITY = 0.42
const PUSHUP_SHOULDER_HIP_RATIO_MAX = 0.24
const PUSHUP_HIP_ANKLE_RATIO_MAX = 0.26
const PUSHUP_HORIZONTAL_RATIO_MAX = 0.34
const PUSHUP_SHOULDER_ELBOW_STACK_RATIO_MAX = 0.24

export class PushUpSessionEngine {
  constructor(protocol) {
    this.protocol = protocol
    this.smoothing = {
      elbowAngle: [],
      bodyAngle: []
    }
    this.phase = "WAITING_FOR_START_POSITION"
    this.setNumber = 1
    this.repInSet = 0
    this.totalReps = 0
    this.validReps = 0
    this.invalidReps = 0
    this.results = []
    this.readyStableSince = null
    this.repStartedAt = null
    this.bottomHoldSince = null
    this.restStartedAt = null
    this.needsSetStartCheck = true
    this.currentRep = this.createRepTracker()
    this.lastMetrics = null
    this.restGetReadyAnnounced = false
    this.lastVoiceAt = new Map()
    this.lastAnyVoiceAt = -Infinity
    this.lastVoiceKey = null
    this.trackedSide = null
    this.pendingSide = null
    this.pendingSideFrames = 0
  }

  getSnapshot() {
    return this.buildSnapshot(null, this.messageForState(null))
  }

  tickWithoutPose(timestampMs) {
    const events = []

    if (this.phase === "REST") {
      this.handleRestTick(timestampMs, null, events)
      return {
        snapshot: this.buildSnapshot(null, this.messageForState(null)),
        events
      }
    }

    if (this.needsSetStartCheck) {
      if (this.phase !== "WAITING_FOR_START_POSITION" && this.phase !== "SESSION_COMPLETE") {
        this.phase = "WAITING_FOR_START_POSITION"
        this.clearMovementState()
      }

      this.readyStableSince = null
      this.maybeSpeak(events, "move-into-frame", PUSHUP_READY_COPY["move-into-frame"], timestampMs, 2600)

      return {
        snapshot: this.buildSnapshot(null, PUSHUP_READY_COPY["move-into-frame"]),
        events
      }
    }

    return {
      snapshot: this.buildSnapshot(null, this.messageForState(null)),
      events
    }
  }

  processLandmarks(landmarks, timestampMs) {
    const frame = this.analyzeFrame(landmarks)
    const events = []

    if (this.phase === "REST") {
      this.handleRestTick(timestampMs, frame, events)
      return {
        snapshot: this.buildSnapshot(frame, this.messageForState(frame)),
        events
      }
    }

    if (!frame.canTrack) {
      return this.pauseForTracking(frame, timestampMs, events)
    }

    if (this.needsSetStartCheck && (!frame.orientation.accepted || !frame.startPostureOk)) {
      this.phase = "WAITING_FOR_START_POSITION"
      this.readyStableSince = null
      this.clearMovementState()
      this.maybeSpeak(events, frame.orientation.reason, PUSHUP_READY_COPY[frame.orientation.reason], timestampMs, 2000)
      this.captureTopMetrics(frame)
      return {
        snapshot: this.buildSnapshot(frame, PUSHUP_READY_COPY[frame.orientation.reason]),
        events
      }
    }

    switch (this.phase) {
      case "WAITING_FOR_START_POSITION":
        if (!this.needsSetStartCheck) {
          this.phase = "READY"
          this.captureTopMetrics(frame)
          break
        }

        if (this.readyStableSince === null) {
          this.readyStableSince = timestampMs
        }

        if (timestampMs - this.readyStableSince >= 650) {
          this.phase = "READY"
          this.needsSetStartCheck = false
          this.captureTopMetrics(frame)
          this.maybeSpeak(events, "start-performing", "Start performing the exercise.", timestampMs, 900)
        }
        break

      case "READY":
        if (this.shouldStartDescending(frame)) {
          this.phase = "DESCENDING"
          this.repStartedAt = timestampMs
          this.currentRep = this.createRepTracker()
        } else if (this.isTopPosition(frame)) {
          this.captureTopMetrics(frame)
        }
        break

      case "DESCENDING":
      case "BOTTOM":
      case "ASCENDING":
        this.trackRepFrame(frame, timestampMs, events)
        break

      default:
        break
    }

    this.lastMetrics = frame.metrics

    return {
      snapshot: this.buildSnapshot(frame, this.messageForState(frame)),
      events
    }
  }

  createRepTracker() {
    return {
      depthReached: false,
      bodyLineErrorFrames: 0,
      depthWarned: false,
      extensionWarned: false,
      minElbowAngle: 180,
      minBodyAngle: 180,
      maxElbowAngle: 0,
      feedback: new Set()
    }
  }

  clearMovementState() {
    this.repStartedAt = null
    this.bottomHoldSince = null
    this.currentRep = this.createRepTracker()
  }

  captureTopMetrics(frame) {
    this.lastMetrics = frame.metrics
  }

  shouldStartDescending(frame) {
    return frame.metrics.elbowAngle < 140
  }

  isTopPosition(frame) {
    return frame.metrics.elbowAngle > 150
  }

  isMovingUp(frame) {
    if (this.lastMetrics === null) return false
    return frame.metrics.elbowAngle >= this.lastMetrics.elbowAngle + 2
  }

  isMovingDown(frame) {
    if (this.lastMetrics === null) return false
    return frame.metrics.elbowAngle <= this.lastMetrics.elbowAngle - 2
  }

  pauseForTracking(frame, timestampMs, events) {
    this.phase = "WAITING_FOR_START_POSITION"
    this.needsSetStartCheck = true
    this.readyStableSince = null
    this.clearMovementState()
    this.maybeSpeak(events, frame.orientation.reason, PUSHUP_READY_COPY[frame.orientation.reason], timestampMs, 2000)

    return {
      snapshot: this.buildSnapshot(frame, PUSHUP_READY_COPY[frame.orientation.reason]),
      events
    }
  }

  trackRepFrame(frame, timestampMs, events) {
    this.currentRep.depthReached = this.currentRep.depthReached || frame.metrics.elbowAngle < 100
    this.currentRep.minElbowAngle = Math.min(this.currentRep.minElbowAngle, frame.metrics.elbowAngle)
    this.currentRep.minBodyAngle = Math.min(this.currentRep.minBodyAngle, frame.metrics.bodyAngle)
    this.currentRep.maxElbowAngle = Math.max(this.currentRep.maxElbowAngle, frame.metrics.elbowAngle)

    if (frame.metrics.bodyAngle < 160) {
      this.currentRep.bodyLineErrorFrames += 1
      this.currentRep.feedback.add("Keep your body straight")
      this.maybeSpeak(events, "body-line", "Keep your body straight", timestampMs, 2000)
    }

    if (this.phase === "DESCENDING") {
      if (frame.metrics.elbowAngle < 100 || this.currentRep.depthReached) {
        this.phase = "BOTTOM"
        return
      }

      if (this.isMovingUp(frame)) {
        if (!this.currentRep.depthWarned) {
          this.currentRep.depthWarned = true
          this.currentRep.feedback.add("Go lower")
          this.maybeSpeak(events, "go-lower", "Go lower", timestampMs, 2000)
        }

        this.clearMovementState()
        this.captureTopMetrics(frame)
        this.phase = "READY"
      }

      return
    }

    if (this.phase === "BOTTOM") {
      if (this.isMovingUp(frame)) {
        this.phase = "ASCENDING"
      }
      return
    }

    if (this.phase === "ASCENDING") {
      if (this.isTopPosition(frame)) {
        this.completeRep(frame, timestampMs, events)
        return
      }

      if (this.isMovingDown(frame) && !this.currentRep.extensionWarned) {
        this.currentRep.extensionWarned = true
        this.currentRep.feedback.add("Extend your arms")
        this.maybeSpeak(events, "extend-arms", "Extend your arms", timestampMs, 2000)
      }

      if (frame.metrics.elbowAngle < 100) {
        this.phase = "BOTTOM"
      }
    }
  }

  completeRep(frame, timestampMs, events) {
    const depthScore = clamp(Math.round(100 - Math.max(0, this.currentRep.minElbowAngle - 90) * 2), 20, 100)
    const postureScore = clamp(Math.round(100 - this.currentRep.bodyLineErrorFrames * 6), 20, 100)

    const repResult = {
      setNumber: this.setNumber,
      repInSet: this.repInSet + 1,
      depthValid: true,
      postureValid: this.currentRep.bodyLineErrorFrames === 0,
      valid: true,
      depthScore,
      postureScore,
      feedback: Array.from(this.currentRep.feedback)
    }

    this.totalReps += 1
    this.repInSet += 1
    this.results.push(repResult)
    this.validReps += 1

    this.maybeSpeak(events, `rep-${this.repInSet}`, String(this.repInSet), timestampMs, 0, true)

    this.clearMovementState()
    this.captureTopMetrics(frame)

    if (this.repInSet >= this.protocol.repsPerSet) {
      if (this.setNumber >= this.protocol.sets) {
        this.phase = "SESSION_COMPLETE"
        this.maybeSpeak(events, "great-job", "Great job.", timestampMs, 0, true)
      } else {
        this.phase = "REST"
        this.setNumber += 1
        this.repInSet = 0
        this.restStartedAt = timestampMs
        this.restGetReadyAnnounced = false
        this.maybeSpeak(events, "rest-time", "Rest time.", timestampMs, 0, true)
      }
      return
    }

    this.phase = "READY"
  }

  handleRestTick(timestampMs, frame, events) {
    if (this.restStartedAt === null) {
      this.restStartedAt = timestampMs
    }

    const remainingMs = Math.max(0, this.protocol.restSeconds * 1000 - (timestampMs - this.restStartedAt))

    if (!this.restGetReadyAnnounced && remainingMs <= 5000) {
      this.restGetReadyAnnounced = true
      this.maybeSpeak(events, "get-ready", "Get ready.", timestampMs, 0)
    }

    if (remainingMs > 0) {
      if (remainingMs <= 5000 && frame && !frame.readyToStart) {
        this.maybeSpeak(events, frame.orientation.reason, PUSHUP_READY_COPY[frame.orientation.reason], timestampMs, 2400)
      }
      return
    }

    this.phase = "WAITING_FOR_START_POSITION"
    this.restStartedAt = null
    this.readyStableSince = null
    this.currentRep = this.createRepTracker()
    this.needsSetStartCheck = true

    if (frame && frame.readyToStart) {
      this.readyStableSince = timestampMs
      this.captureTopMetrics(frame)
      this.phase = "READY"
      this.needsSetStartCheck = false
      this.maybeSpeak(events, "start-performing", "Start performing the exercise.", timestampMs, 900)
    }
  }

  maybeSpeak(events, key, message, timestampMs, minIntervalMs = 2000, interrupt = false) {
    const last = this.lastVoiceAt.has(key) ? this.lastVoiceAt.get(key) : -Infinity
    if (timestampMs - last < minIntervalMs) return
    if (!interrupt && timestampMs - this.lastAnyVoiceAt < 2000) return
    if (!interrupt && this.lastVoiceKey === key) return
    if (events.some((event) => event.type === "voice")) return

    this.lastVoiceAt.set(key, timestampMs)
    this.lastAnyVoiceAt = timestampMs
    this.lastVoiceKey = key
    events.push({ type: "voice", key, message, interrupt })
  }

  analyzeFrame(landmarks) {
    const leftPoints = {
      shoulder: toPoint(landmarks, PUSHUP_LANDMARK_INDEX.leftShoulder),
      elbow: toPoint(landmarks, PUSHUP_LANDMARK_INDEX.leftElbow),
      hip: toPoint(landmarks, PUSHUP_LANDMARK_INDEX.leftHip),
      ankle: toPoint(landmarks, PUSHUP_LANDMARK_INDEX.leftAnkle)
    }
    const rightPoints = {
      shoulder: toPoint(landmarks, PUSHUP_LANDMARK_INDEX.rightShoulder),
      elbow: toPoint(landmarks, PUSHUP_LANDMARK_INDEX.rightElbow),
      hip: toPoint(landmarks, PUSHUP_LANDMARK_INDEX.rightHip),
      ankle: toPoint(landmarks, PUSHUP_LANDMARK_INDEX.rightAnkle)
    }

    const leftMeanVisibility = average([
      leftPoints.shoulder.visibility,
      leftPoints.elbow.visibility,
      leftPoints.hip.visibility,
      leftPoints.ankle.visibility
    ])
    const rightMeanVisibility = average([
      rightPoints.shoulder.visibility,
      rightPoints.elbow.visibility,
      rightPoints.hip.visibility,
      rightPoints.ankle.visibility
    ])

    const leftDepthScore = -average([leftPoints.shoulder.z, leftPoints.elbow.z, leftPoints.hip.z, leftPoints.ankle.z])
    const rightDepthScore = -average([
      rightPoints.shoulder.z,
      rightPoints.elbow.z,
      rightPoints.hip.z,
      rightPoints.ankle.z
    ])
    const leftSelectorScore = leftMeanVisibility + leftDepthScore * 0.02
    const rightSelectorScore = rightMeanVisibility + rightDepthScore * 0.02
    const candidateSide = leftSelectorScore >= rightSelectorScore ? "left" : "right"

    if (this.trackedSide === null) {
      this.trackedSide = candidateSide
      this.pendingSide = null
      this.pendingSideFrames = 0
    } else if (candidateSide !== this.trackedSide) {
      const candidateScore = candidateSide === "left" ? leftSelectorScore : rightSelectorScore
      const currentScore = this.trackedSide === "left" ? leftSelectorScore : rightSelectorScore
      if (candidateScore > currentScore + PUSHUP_SIDE_SWITCH_MARGIN) {
        if (this.pendingSide === candidateSide) {
          this.pendingSideFrames += 1
        } else {
          this.pendingSide = candidateSide
          this.pendingSideFrames = 1
        }

        if (this.pendingSideFrames >= 3) {
          this.trackedSide = candidateSide
          this.pendingSide = null
          this.pendingSideFrames = 0
        }
      } else {
        this.pendingSide = null
        this.pendingSideFrames = 0
      }
    } else {
      this.pendingSide = null
      this.pendingSideFrames = 0
    }

    const trackedSide = this.trackedSide
    const sidePoints = trackedSide === "left" ? leftPoints : rightPoints
    const trackedSideMean = trackedSide === "left" ? leftMeanVisibility : rightMeanVisibility
    const farSideMean = trackedSide === "left" ? rightMeanVisibility : leftMeanVisibility
    const bodyLength = Math.max(distance(sidePoints.shoulder, sidePoints.ankle), 0.001)
    const shoulderGapRatio = Math.abs(leftPoints.shoulder.x - rightPoints.shoulder.x) / bodyLength
    const hipGapRatio = Math.abs(leftPoints.hip.x - rightPoints.hip.x) / bodyLength
    const sideViewRatio = Math.max(shoulderGapRatio, hipGapRatio)
    const bodyVerticalSpread =
      Math.max(sidePoints.shoulder.y, sidePoints.hip.y, sidePoints.ankle.y) -
      Math.min(sidePoints.shoulder.y, sidePoints.hip.y, sidePoints.ankle.y)
    const horizontalRatio = bodyVerticalSpread / bodyLength
    const shoulderHipDelta = Math.abs(sidePoints.shoulder.y - sidePoints.hip.y)
    const hipAnkleDelta = Math.abs(sidePoints.hip.y - sidePoints.ankle.y)
    const shoulderHipRatio = shoulderHipDelta / bodyLength
    const hipAnkleRatio = hipAnkleDelta / bodyLength
    const shoulderElbowStackRatio = Math.abs(sidePoints.shoulder.x - sidePoints.elbow.x) / bodyLength
    const isHorizontal =
      shoulderHipRatio <= PUSHUP_SHOULDER_HIP_RATIO_MAX &&
      hipAnkleRatio <= PUSHUP_HIP_ANKLE_RATIO_MAX &&
      horizontalRatio <= PUSHUP_HORIZONTAL_RATIO_MAX

    const requiredVisible =
      trackedSideMean >= PUSHUP_TRACKED_SIDE_MIN_VISIBILITY &&
      [sidePoints.shoulder, sidePoints.elbow, sidePoints.hip, sidePoints.ankle].every(
        (point) => point.visibility >= PUSHUP_POINT_MIN_VISIBILITY
      )

    const fullBodyVisible =
      inFrame(sidePoints.shoulder) &&
      inFrame(sidePoints.elbow) &&
      inFrame(sidePoints.hip) &&
      inFrame(sidePoints.ankle)

    let reason = "move-into-frame"

    if (!fullBodyVisible) {
      reason = "adjust-position"
    } else if (sideViewRatio > PUSHUP_SIDE_VIEW_RATIO_MAX) {
      reason = "turn-sideways"
    } else if (!requiredVisible || trackedSideMean - farSideMean < 0.02) {
      reason = "adjust-position"
    }

    const orientationAccepted =
      requiredVisible &&
      fullBodyVisible &&
      sideViewRatio <= PUSHUP_SIDE_VIEW_RATIO_MAX &&
      (trackedSideMean - farSideMean >= -0.02 || sideViewRatio <= 0.16)

    const elbowAngle = this.smooth("elbowAngle", angleABC(sidePoints.shoulder, sidePoints.elbow, sidePoints.hip))
    const bodyAngle = this.smooth("bodyAngle", angleABC(sidePoints.shoulder, sidePoints.hip, sidePoints.ankle))
    const armsStraight = elbowAngle >= PUSHUP_READY_ELBOW_MIN
    const bodyStraight = bodyAngle >= PUSHUP_READY_BODY_MIN
    const shoulderStacked = shoulderElbowStackRatio <= PUSHUP_SHOULDER_ELBOW_STACK_RATIO_MAX
    const startPostureOk = armsStraight && bodyStraight && isHorizontal && shoulderStacked
    const canTrack = requiredVisible && fullBodyVisible && sideViewRatio <= PUSHUP_SIDE_VIEW_RATIO_MAX

    if (!canTrack) {
      reason = reason === "turn-sideways" ? reason : "move-into-frame"
    } else if (orientationAccepted && !startPostureOk) {
      reason = "pushup-position"
    }

    return {
      canTrack,
      trackedSide,
      sidePoints,
      orientation: {
        accepted: orientationAccepted,
        reason,
        fullBodyVisible,
        sideViewRatio
      },
      startPostureOk,
      readyToStart: orientationAccepted && startPostureOk,
      metrics: {
        elbowAngle,
        bodyAngle,
        armsStraight,
        bodyStraight,
        isHorizontal,
        shoulderHipDelta,
        hipAnkleDelta,
        shoulderHipRatio,
        hipAnkleRatio,
        horizontalRatio,
        orientationAccepted,
        bodyLength,
        sideViewRatio,
        shoulderElbowStackRatio,
        shoulderStacked
      }
    }
  }

  smooth(key, rawValue) {
    const bucket = this.smoothing[key]
    bucket.push(rawValue)
    if (bucket.length > 3) bucket.shift()
    return average(bucket)
  }

  buildSnapshot(frame, coachMessage) {
    const depthScore =
      this.results.length === 0
        ? 0
        : Math.round(this.results.reduce((sum, result) => sum + result.depthScore, 0) / this.results.length)
    const postureScore =
      this.results.length === 0
        ? 0
        : Math.round(this.results.reduce((sum, result) => sum + result.postureScore, 0) / this.results.length)
    const restRemainingMs =
      this.phase === "REST" && this.restStartedAt !== null
        ? Math.max(0, this.protocol.restSeconds * 1000 - (performance.now() - this.restStartedAt))
        : 0

    return {
      phase: this.phase,
      phaseLabel: PHASE_COPY[this.phase],
      setNumber: this.setNumber,
      repInSet: this.repInSet,
      totalReps: this.totalReps,
      validReps: this.validReps,
      invalidReps: this.invalidReps,
      depthScore,
      postureScore,
      restRemainingMs,
      orientationAccepted: frame ? frame.orientation.accepted : false,
      fullBodyVisible: frame ? frame.orientation.fullBodyVisible : false,
      startPostureOk: frame ? frame.startPostureOk : false,
      positionReady: frame ? frame.readyToStart : false,
      trackedSide: frame ? frame.trackedSide : null,
      coachMessage,
      metrics: frame ? frame.metrics : null,
      results: this.results
    }
  }

  messageForState(frame) {
    if (this.phase === "REST") {
      return "Rest time. Reset your plank and get ready for the next set."
    }
    if (this.phase === "READY") {
      return "Start performing the exercise."
    }
    if (this.phase === "DESCENDING") {
      return "Lower with control."
    }
    if (this.phase === "BOTTOM") {
      return "Push the floor away."
    }
    if (this.phase === "ASCENDING") {
      return "Extend your arms."
    }
    if (this.phase === "SESSION_COMPLETE") {
      return "Great job."
    }

    return PUSHUP_READY_COPY[frame ? frame.orientation.reason : "move-into-frame"]
  }
}
