import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest"
import { PushUpSessionEngine, SquatSessionEngine, VoiceCoach } from "./engines.js"

const EXERCISES = {
  squat: {
    id: "squat",
    title: "Squat rule test",
    description: "A stripped-down copy of the live training session focused on side-view squat validation.",
    tag: "Depth and posture",
    protocol: { sets: 3, repsPerSet: 5, restSeconds: 15 },
    viewLabel: "Side or slight 3/4 view",
    viewCopy: "Stand far enough back so your head, hips, knees, heels, and toes stay fully visible.",
    ruleLabel: "Depth, torso, heels",
    ruleCopy: "Voice cues call out setup, depth, torso lean, and heel lift while the session advances through sets and rest.",
    highlights: [
      "Waits for a clean side-view start position before the first rep.",
      "Tracks set and rep progress with the same 3 x 5 session shape.",
      "Uses the on-screen position layer plus spoken corrections."
    ],
    renderVisual() {
      return `
        <div class="exercise-visual is-illustration">
          <div class="exercise-illustration" aria-hidden="true">
            <svg viewBox="0 0 360 220" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="18" y="22" width="324" height="176" rx="28" fill="rgba(8,18,34,0.76)" stroke="rgba(255,255,255,0.08)"/>
              <path d="M110 64L144 104L178 128L216 156L250 168" stroke="#63D8FF" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="110" cy="64" r="15" fill="#7A8CFF"/>
              <circle cx="144" cy="104" r="11" fill="#63D8FF"/>
              <circle cx="178" cy="128" r="11" fill="#63D8FF"/>
              <circle cx="216" cy="156" r="11" fill="#63D8FF"/>
              <circle cx="250" cy="168" r="11" fill="#63D8FF"/>
              <path d="M44 182H316" stroke="rgba(255,255,255,0.12)" stroke-width="6" stroke-linecap="round"/>
              <path d="M90 50C128 18 208 18 256 64" stroke="rgba(122,140,255,0.4)" stroke-width="6" stroke-linecap="round"/>
            </svg>
          </div>
        </div>
      `
    },
    createEngine(protocol) {
      return new SquatSessionEngine(protocol)
    }
  },
  pushup: {
    id: "pushup",
    title: "Push-up rule test",
    description: "Uses the updated MediaPipe-optimized push-up rules: shoulder-elbow-hip rep proxy, body-line checks, and no wrist dependency.",
    tag: "Proxy elbow and body line",
    protocol: { sets: 3, repsPerSet: 5, restSeconds: 15 },
    viewLabel: "Low side or 3/4 floor view",
    viewCopy: "Place the phone low enough to keep shoulder, elbow, hip, and ankle visible while your body stays parallel to the floor.",
    ruleLabel: "Elbow proxy and body angle",
    ruleCopy: "Rep detection uses the shoulder-elbow-hip proxy angle plus shoulder-hip-ankle alignment, with body-line cues prioritized ahead of depth and lockout.",
    highlights: [
      "Uses only shoulder, elbow, hip, and ankle landmarks from the clearest side.",
      "Requires a straight body, extended arms, and a floor-parallel setup before counting starts.",
      "Counts completed reps while still voicing alignment corrections during the movement."
    ],
    renderVisual() {
      return `
        <div class="exercise-visual">
          <div class="reference-strip">
            <img src="assets/push-up-1.webp" alt="Push-up coaching reference">
            <img src="assets/push-up-2.webp" alt="Push-up alignment reference">
          </div>
        </div>
      `
    },
    createEngine(protocol) {
      return new PushUpSessionEngine(protocol)
    }
  }
}

const state = {
  screen: "picker",
  selectedExerciseId: null,
  poseLandmarker: null,
  stream: null,
  running: false,
  lastVideoTime: -1,
  rafId: 0,
  engine: null,
  snapshot: null
}

const voiceCoach = new VoiceCoach()

const els = {
  screens: Array.from(document.querySelectorAll("[data-screen]")),
  exerciseGrid: document.getElementById("exercise-grid"),
  liveExerciseTitle: document.getElementById("live-exercise-title"),
  overlayTitle: document.getElementById("overlay-title"),
  overlayCopy: document.getElementById("overlay-copy"),
  viewHintLabel: document.getElementById("view-hint-label"),
  viewHintCopy: document.getElementById("view-hint-copy"),
  ruleHintLabel: document.getElementById("rule-hint-label"),
  ruleHintCopy: document.getElementById("rule-hint-copy"),
  changeExerciseBtn: document.getElementById("change-exercise-btn"),
  resetSessionBtn: document.getElementById("reset-session-btn"),
  startCameraBtn: document.getElementById("start-camera-btn"),
  cameraPrompt: document.getElementById("camera-prompt"),
  cameraVideo: document.getElementById("camera-video"),
  cameraCanvas: document.getElementById("camera-canvas"),
  liveSetValue: document.getElementById("live-set-value"),
  liveRepValue: document.getElementById("live-rep-value"),
  positionChip: document.getElementById("position-chip"),
  coachMessage: document.getElementById("coach-message"),
  restPill: document.getElementById("rest-pill"),
  cameraError: document.getElementById("camera-error")
}

function setScreen(nextScreen) {
  state.screen = nextScreen
  for (const screen of els.screens) {
    screen.hidden = screen.dataset.screen !== nextScreen
  }
}

function getSelectedExercise() {
  return state.selectedExerciseId ? EXERCISES[state.selectedExerciseId] : null
}

function renderExerciseCards() {
  els.exerciseGrid.innerHTML = ""

  for (const exercise of Object.values(EXERCISES)) {
    const card = document.createElement("article")
    card.className = "exercise-card"
    card.innerHTML = `
      ${exercise.renderVisual()}
      <div class="exercise-copy">
        <div class="exercise-head">
          <div>
            <p class="eyebrow">Exercise test</p>
            <h2>${exercise.title}</h2>
          </div>
          <span class="exercise-tag">${exercise.tag}</span>
        </div>

        <p class="exercise-description">${exercise.description}</p>

        <ul class="exercise-rule-list">
          ${exercise.highlights.map((item) => `<li>${item}</li>`).join("")}
        </ul>

        <div class="card-actions">
          <button class="primary-button" type="button" data-exercise-id="${exercise.id}">Open test page</button>
        </div>
      </div>
    `

    const button = card.querySelector("[data-exercise-id]")
    button.addEventListener("click", () => {
      selectExercise(exercise.id)
    })

    els.exerciseGrid.append(card)
  }
}

function selectExercise(exerciseId) {
  const exercise = EXERCISES[exerciseId]
  state.selectedExerciseId = exerciseId
  state.engine = exercise.createEngine(exercise.protocol)
  state.snapshot = state.engine.getSnapshot()

  els.liveExerciseTitle.textContent = exercise.title
  els.overlayTitle.textContent = exercise.title
  els.overlayCopy.textContent = `${exercise.description} Open the camera, get into the required view, and the voice coach will guide the start position.`
  els.viewHintLabel.textContent = exercise.viewLabel
  els.viewHintCopy.textContent = exercise.viewCopy
  els.ruleHintLabel.textContent = exercise.ruleLabel
  els.ruleHintCopy.textContent = exercise.ruleCopy
  els.cameraPrompt.hidden = false
  els.cameraError.hidden = true
  els.cameraError.textContent = ""

  renderSnapshot(state.snapshot)
  setScreen("live")
}

function renderSnapshot(snapshot) {
  const exercise = getSelectedExercise()
  if (!exercise || !snapshot) return

  const setLabel =
    snapshot.phase === "SESSION_COMPLETE"
      ? `${exercise.protocol.sets} / ${exercise.protocol.sets}`
      : `${snapshot.setNumber} / ${exercise.protocol.sets}`
  const repLabel =
    snapshot.phase === "SESSION_COMPLETE"
      ? `${exercise.protocol.repsPerSet} / ${exercise.protocol.repsPerSet}`
      : `${snapshot.repInSet} / ${exercise.protocol.repsPerSet}`

  const positionReady =
    snapshot.phase === "READY" ||
    snapshot.phase === "DESCENDING" ||
    snapshot.phase === "BOTTOM" ||
    snapshot.phase === "ASCENDING" ||
    snapshot.phase === "SESSION_COMPLETE" ||
    (snapshot.orientationAccepted && snapshot.startPostureOk)

  els.liveSetValue.textContent = setLabel
  els.liveRepValue.textContent = repLabel
  els.coachMessage.textContent = snapshot.coachMessage

  els.positionChip.className = "status-pill"

  if (snapshot.phase === "SESSION_COMPLETE") {
    els.positionChip.textContent = "Session complete"
    els.positionChip.classList.add("is-complete")
  } else if (snapshot.phase === "REST") {
    els.positionChip.textContent = "Rest"
  } else if (positionReady) {
    els.positionChip.textContent = "Starting position ready"
    els.positionChip.classList.add("is-ready")
  } else {
    els.positionChip.textContent = "Adjust position"
  }

  if (snapshot.phase === "REST") {
    els.restPill.hidden = false
    els.restPill.textContent = `Rest ${Math.ceil(snapshot.restRemainingMs / 1000)}s`
  } else {
    els.restPill.hidden = true
  }
}

function handleEngineEvents(events) {
  for (const event of events) {
    voiceCoach.speak({
      key: event.key,
      message: event.message,
      interrupt: event.interrupt
    })
  }
}

function syncCanvasToVideo() {
  if (els.cameraVideo.videoWidth === 0 || els.cameraVideo.videoHeight === 0) return
  if (
    els.cameraCanvas.width !== els.cameraVideo.videoWidth ||
    els.cameraCanvas.height !== els.cameraVideo.videoHeight
  ) {
    els.cameraCanvas.width = els.cameraVideo.videoWidth
    els.cameraCanvas.height = els.cameraVideo.videoHeight
  }
}

function toCanvasPoint(point) {
  return {
    x: point.x * els.cameraCanvas.width,
    y: point.y * els.cameraCanvas.height
  }
}

function drawPose(landmarks, trackedSide) {
  syncCanvasToVideo()

  const context = els.cameraCanvas.getContext("2d")
  if (!context) return

  context.clearRect(0, 0, els.cameraCanvas.width, els.cameraCanvas.height)
  if (!landmarks || landmarks.length === 0) return

  const exerciseId = state.selectedExerciseId
  const side = trackedSide || "left"
  const chain =
    exerciseId === "pushup"
      ? side === "left"
        ? [11, 13, 23, 27]
        : [12, 14, 24, 28]
      : side === "left"
        ? [11, 23, 25, 27, 29, 31]
        : [12, 24, 26, 28, 30, 32]

  const points = chain.map((index) => toCanvasPoint(landmarks[index]))

  context.lineWidth = 8
  context.lineCap = "round"
  context.lineJoin = "round"
  context.strokeStyle = side === "left" ? "#63d8ff" : "#ffbd7a"

  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y)
  }
  context.stroke()

  for (const point of points) {
    context.beginPath()
    context.arc(point.x, point.y, 6, 0, Math.PI * 2)
    context.fillStyle = "#f4f7fb"
    context.fill()

    context.beginPath()
    context.arc(point.x, point.y, 3.5, 0, Math.PI * 2)
    context.fillStyle = side === "left" ? "#63d8ff" : "#ffbd7a"
    context.fill()
  }
}

async function ensurePoseLandmarker() {
  if (state.poseLandmarker) return state.poseLandmarker

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  )

  state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
    },
    runningMode: "VIDEO",
    numPoses: 1
  })

  return state.poseLandmarker
}

async function stopLiveResources() {
  state.running = false

  if (state.rafId) {
    cancelAnimationFrame(state.rafId)
    state.rafId = 0
  }

  if (state.stream) {
    for (const track of state.stream.getTracks()) {
      track.stop()
    }
    state.stream = null
  }

  els.cameraVideo.srcObject = null

  const context = els.cameraCanvas.getContext("2d")
  if (context) {
    context.clearRect(0, 0, els.cameraCanvas.width, els.cameraCanvas.height)
  }
  voiceCoach.stop()
}

function resetSession() {
  const exercise = getSelectedExercise()
  if (!exercise) return

  state.engine = exercise.createEngine(exercise.protocol)
  state.snapshot = state.engine.getSnapshot()
  renderSnapshot(state.snapshot)
  voiceCoach.stop()

  if (!state.stream) {
    els.cameraPrompt.hidden = false
    return
  }

  els.cameraPrompt.hidden = true
  voiceCoach.speak({
    key: `${exercise.id}-welcome`,
    message: `${exercise.title}. ${exercise.protocol.sets} sets of ${exercise.protocol.repsPerSet} reps. Get into position.`,
    interrupt: true,
    minIntervalMs: 0
  })
}

function handleLandmarks(landmarks, timestampMs) {
  if (!state.engine) return

  const update = landmarks
    ? state.engine.processLandmarks(landmarks, timestampMs)
    : state.engine.tickWithoutPose(timestampMs)

  state.snapshot = update.snapshot
  renderSnapshot(update.snapshot)
  handleEngineEvents(update.events)

  if (update.snapshot.phase === "SESSION_COMPLETE") {
    els.cameraPrompt.hidden = true
  }
}

function startLoop() {
  const step = () => {
    if (!state.running || !state.poseLandmarker) return

    state.rafId = requestAnimationFrame(step)

    if (els.cameraVideo.readyState < 2) return
    if (els.cameraVideo.currentTime === state.lastVideoTime) return

    state.lastVideoTime = els.cameraVideo.currentTime
    const result = state.poseLandmarker.detectForVideo(els.cameraVideo, performance.now())
    const landmarks = result.landmarks && result.landmarks.length > 0 ? result.landmarks[0] : null
    const trackedSide = state.snapshot && state.snapshot.trackedSide ? state.snapshot.trackedSide : null

    drawPose(landmarks, trackedSide)
    handleLandmarks(landmarks, performance.now())
  }

  state.rafId = requestAnimationFrame(step)
}

async function startCamera() {
  const exercise = getSelectedExercise()
  if (!exercise) return

  els.startCameraBtn.disabled = true
  els.cameraError.hidden = true
  els.cameraError.textContent = ""

  try {
    await ensurePoseLandmarker()
    await stopLiveResources()

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    })

    state.stream = stream
    state.running = true
    state.lastVideoTime = -1

    els.cameraVideo.srcObject = stream
    await els.cameraVideo.play()
    syncCanvasToVideo()

    resetSession()
    startLoop()
    els.cameraPrompt.hidden = true
  } catch (error) {
    els.cameraError.hidden = false
    els.cameraError.textContent =
      error instanceof Error
        ? error.message
        : "Camera access failed. Use HTTPS and allow the front camera."
    els.cameraPrompt.hidden = false
  } finally {
    els.startCameraBtn.disabled = false
  }
}

async function changeExercise() {
  await stopLiveResources()
  state.snapshot = null
  state.engine = null
  state.selectedExerciseId = null
  setScreen("picker")
}

function registerEvents() {
  els.changeExerciseBtn.addEventListener("click", () => {
    void changeExercise()
  })

  els.resetSessionBtn.addEventListener("click", () => {
    resetSession()
  })

  els.startCameraBtn.addEventListener("click", () => {
    void startCamera()
  })

  window.addEventListener("resize", syncCanvasToVideo)
  window.addEventListener("beforeunload", () => {
    void stopLiveResources()
  })
}

renderExerciseCards()
registerEvents()
setScreen("picker")
