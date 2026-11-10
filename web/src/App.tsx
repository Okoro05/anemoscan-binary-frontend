import {
  Camera,
  CheckCircle2,
  FlipHorizontal2,
  Flashlight,
  Loader2,
  RotateCcw,
  ScanLine,
  ShieldAlert,
  Volume2,
  VolumeX,
  Upload,
  UserPlus,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'

import { analyzeCapture, createCapture, imageUrl, predictEyeState } from './lib/api'
import { getCaptureGuidance } from './lib/capture-guidance'
import type { Capture, Gender, NewCapture } from './lib/api'

const qualityThreshold = 65
const analysisTimeoutMs = 90_000
const maxImportSide = 1280

type FacingMode = 'user' | 'environment'
type DistanceStatus = 'no-eye' | 'good'
type FlowStage = 'patient' | 'capture' | 'analyzing' | 'result'

type BaseMetrics = {
  brightness: number
  sharpness: number
  contrast: number
  overall: number
}
type Metrics = BaseMetrics & {
  distanceStatus: DistanceStatus
  skinRatio: number
  scleraRatio: number
}

const initialMetrics: Metrics = {
  brightness: 58,
  sharpness: 72,
  contrast: 54,
  overall: 61,
  distanceStatus: 'good',
  skinRatio: 0.4,
  scleraRatio: 0.02,
}

const MIN_SKIN_RATIO = 0.08
const MIN_SCLERA_RATIO = 0.025
const PATIENT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

function round(value: number) {
  return Math.round(clamp(value))
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function normalizePatientId(value: string) {
  return value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-/, '').slice(0, 40)
}

function isSkinTone(r: number, g: number, b: number) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  return y > 40 && cb >= 77 && cb <= 135 && cr >= 133 && cr <= 180
}

function isScleraTone(r: number, g: number, b: number) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const brightness = (r + g + b) / 3
  const saturation = max === 0 ? 0 : (max - min) / max
  return brightness > 140 && saturation < 0.25
}

// The capture window is calibrated to the supplied close-up conjunctiva reference:
 // one eye should occupy most of the guide, rather than a small oval in the middle.
const EYE_ROI_WIDTH = 0.76
const EYE_ROI_HEIGHT = 0.70
const EYE_ROI_LEFT = 0.12
const EYE_ROI_TOP = 0.15
const DEFAULT_CAMERA_FRAME_ASPECT_RATIO = 16 / 9

function getEyeRoi(width: number, height: number, frameAspectRatio = DEFAULT_CAMERA_FRAME_ASPECT_RATIO) {
  // Map the visible guide through object-fit: cover back to the original camera frame.
  // This keeps the analysis crop and saved crop aligned on portrait and landscape cameras.
  const sourceAspectRatio = width / height
  let visibleLeft = 0
  let visibleTop = 0
  let visibleWidth = width
  let visibleHeight = height

  if (sourceAspectRatio > frameAspectRatio) {
    visibleWidth = height * frameAspectRatio
    visibleLeft = (width - visibleWidth) / 2
  } else if (sourceAspectRatio < frameAspectRatio) {
    visibleHeight = width / frameAspectRatio
    visibleTop = (height - visibleHeight) / 2
  }

  const left = Math.round(visibleLeft + visibleWidth * EYE_ROI_LEFT)
  const top = Math.round(visibleTop + visibleHeight * EYE_ROI_TOP)
  const roiWidth = Math.round(visibleWidth * EYE_ROI_WIDTH)
  const roiHeight = Math.round(visibleHeight * EYE_ROI_HEIGHT)

  return {
    left: Math.max(0, Math.min(width - 1, left)),
    top: Math.max(0, Math.min(height - 1, top)),
    width: Math.max(1, Math.min(width - left, roiWidth)),
    height: Math.max(1, Math.min(height - top, roiHeight)),
  }
}

function getCameraFrameAspectRatio(video: HTMLVideoElement) {
  const frame = video.parentElement
  if (!frame || frame.clientWidth <= 0 || frame.clientHeight <= 0) {
    return DEFAULT_CAMERA_FRAME_ASPECT_RATIO
  }
  return frame.clientWidth / frame.clientHeight
}

function getCaptureRoi(width: number, height: number, frameAspectRatio = DEFAULT_CAMERA_FRAME_ASPECT_RATIO) {
  // Use the exact same mapped region as live quality analysis.
  return getEyeRoi(width, height, frameAspectRatio)
}

async function applySupportedContinuousCameraControls(track: MediaStreamTrack) {
  const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & {
    focusMode?: string[]
    exposureMode?: string[]
    whiteBalanceMode?: string[]
    imageStabilization?: boolean
  }
  const supportedControls: MediaTrackConstraintSet[] = []
  if (capabilities.focusMode?.includes('continuous')) {
    supportedControls.push({ focusMode: 'continuous' } as MediaTrackConstraintSet)
  }
  if (capabilities.exposureMode?.includes('continuous')) {
    supportedControls.push({ exposureMode: 'continuous' } as MediaTrackConstraintSet)
  }
  if (capabilities.whiteBalanceMode?.includes('continuous')) {
    supportedControls.push({ whiteBalanceMode: 'continuous' } as MediaTrackConstraintSet)
  }
  if (capabilities.imageStabilization) {
    supportedControls.push({ imageStabilization: true } as MediaTrackConstraintSet)
  }

  // Apply each supported setting independently so one rejected setting does not
  // prevent the camera from receiving the other available controls.
  for (const control of supportedControls) {
    try {
      await track.applyConstraints({ advanced: [control] })
    } catch {
      // Unsupported optional controls must not interrupt camera startup.
    }
  }
}

function calculateMetricsFromImageData(imageData: ImageData): Metrics {
  const { data, width, height } = imageData
  const luminance = new Float32Array(width * height)
  let sum = 0
  let skinPixels = 0
  let scleraPixels = 0
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const gray = r * 0.299 + g * 0.587 + b * 0.114
    luminance[pixel] = gray
    sum += gray
    if (isSkinTone(r, g, b)) skinPixels += 1
    if (isScleraTone(r, g, b)) scleraPixels += 1
  }
  const mean = sum / luminance.length
  let variance = 0
  let laplacianVariance = 0
  let laplacianCount = 0
  for (let i = 0; i < luminance.length; i += 1) {
    const diff = luminance[i] - mean
    variance += diff * diff
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x
      const laplacian = -4 * luminance[idx] + luminance[idx - 1] + luminance[idx + 1] + luminance[idx - width] + luminance[idx + width]
      laplacianVariance += laplacian * laplacian
      laplacianCount += 1
    }
  }
  const brightness = clamp((mean / 255) * 100)
  const contrast = clamp((Math.sqrt(variance / luminance.length) / 82) * 100)
  const sharpness = clamp((Math.sqrt(laplacianVariance / Math.max(laplacianCount, 1)) / 22) * 100)
  const overall = clamp(brightness * 0.3 + sharpness * 0.4 + contrast * 0.3)
  const skinRatio = skinPixels / luminance.length
  const scleraRatio = scleraPixels / luminance.length
  // Do not infer physical camera distance from skin/sclera colour ratios.
  // Those ratios changed unpredictably across cameras and lighting in the supplied
  // recording. Keep only a conservative "no visible eye-like content" warning;
  // actual distance is calibrated by matching the eye to the guide window.
  const distanceStatus: DistanceStatus =
    scleraRatio < MIN_SCLERA_RATIO && skinRatio < MIN_SKIN_RATIO ? 'no-eye' : 'good'
  return { brightness, sharpness, contrast, overall, distanceStatus, skinRatio, scleraRatio }
}

function describeBlock(metrics: Metrics): string | null {
  const guidance = getCaptureGuidance(metrics, true)
  return guidance.ready ? null : guidance.message
}

async function scoreImageFile(file: File): Promise<{ dataUrl: string; metrics: Metrics }> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('unreadable image'))
      element.src = objectUrl
    })
    const scale = Math.min(1, maxImportSide / Math.max(img.naturalWidth, img.naturalHeight))
    const width = Math.max(1, Math.round(img.naturalWidth * scale))
    const height = Math.max(1, Math.round(img.naturalHeight * scale))
    const roi = getCaptureRoi(width, height)
    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = roi.width
    cropCanvas.height = roi.height
    const cropContext = cropCanvas.getContext('2d', { willReadFrequently: true })
    if (!cropContext) throw new Error('canvas unavailable')
    cropContext.drawImage(img, roi.left, roi.top, roi.width, roi.height, 0, 0, roi.width, roi.height)
    const dataUrl = cropCanvas.toDataURL('image/jpeg', 0.92)
    const analysisWidth = 160
    const analysisHeight = Math.max(90, Math.round((roi.height / roi.width) * analysisWidth))
    const analysisCanvas = document.createElement('canvas')
    analysisCanvas.width = analysisWidth
    analysisCanvas.height = analysisHeight
    const analysisContext = analysisCanvas.getContext('2d', { willReadFrequently: true })
    if (!analysisContext) throw new Error('canvas unavailable')
    analysisContext.drawImage(img, roi.left, roi.top, roi.width, roi.height, 0, 0, analysisWidth, analysisHeight)
    const metrics = calculateMetricsFromImageData(analysisContext.getImageData(0, 0, analysisWidth, analysisHeight))
    return { dataUrl, metrics }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function toNewCapture(imageData: string, metrics: Metrics, patientId: string, age: number, gender: Gender, cameraLabel: string): NewCapture {
  return { imageData, patientId, age, gender, metrics: { brightness: metrics.brightness, sharpness: metrics.sharpness, contrast: metrics.contrast, overall: metrics.overall }, threshold: qualityThreshold, cameraLabel, status: 'READY' }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const lastSpokenGuidanceRef = useRef('')
  const openEyeStreakRef = useRef(0)
  const torchRequestRef = useRef(false)
  const [stage, setStage] = useState<FlowStage>('patient')
  const [patientId, setPatientId] = useState('')
  const [ageInput, setAgeInput] = useState('')
  const [gender, setGender] = useState<Gender | ''>('')
  const [patientError, setPatientError] = useState('')
  const [activeCapture, setActiveCapture] = useState<Capture | null>(null)
  const [analysisError, setAnalysisError] = useState('')
  const [failedSave, setFailedSave] = useState<NewCapture | null>(null)
  const [failedSaveMessage, setFailedSaveMessage] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const [facingMode, setFacingMode] = useState<FacingMode>('user')
  const [metrics, setMetrics] = useState<Metrics>(initialMetrics)
  const [eyeState, setEyeState] = useState<'checking' | 'open' | 'closed' | 'unavailable'>('checking')
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [voiceGuidanceEnabled, setVoiceGuidanceEnabled] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchEnabled, setTorchEnabled] = useState(false)
  const [torchMessage, setTorchMessage] = useState('')

  const qualityOk = metrics.overall >= qualityThreshold
  const distanceOk = metrics.distanceStatus === 'good'
  const baseGuidance = getCaptureGuidance(metrics, cameraReady, saving)
  const guidance = !cameraReady || saving ? baseGuidance : eyeState === 'closed'
    ? { issue: 'camera' as const, title: 'Closed eye detected', message: 'Closed eye detected. Please open your eyes.', detail: 'Capture stays locked until an open eye is consistently detected.', ready: false }
    : eyeState === 'unavailable'
      ? { issue: 'camera' as const, title: 'Eye-state check unavailable', message: 'Unable to verify eye state. Please wait while AnemoScan reconnects.', detail: 'Capture stays locked until the eye-state service responds.', ready: false }
      : eyeState !== 'open'
        ? { issue: 'camera' as const, title: 'Checking eye state', message: 'Please look at the camera while AnemoScan checks that your eye is open.', detail: 'Capture unlocks after two consistent open-eye predictions.', ready: false }
        : baseGuidance
  const accepted = eyeState === 'open' && qualityOk && distanceOk && guidance.ready
  const latestGuidanceRef = useRef(guidance)
  latestGuidanceRef.current = guidance
  const status = accepted ? 'READY' : 'LOW QUALITY'
  const cameraLabel = facingMode === 'user' ? 'FRONT' : 'BACK'

  useEffect(() => {
    if (stage !== 'capture') return
    let stream: MediaStream | null = null
    let cancelled = false
    async function startCamera() {
      setCameraReady(false); setCameraError(''); setMetrics(initialMetrics); setEyeState('checking'); openEyeStreakRef.current = 0
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: ({ facingMode, aspectRatio: { ideal: 16 / 9 }, width: { ideal: 1280 }, height: { ideal: 720 }, resizeMode: 'none' } as MediaTrackConstraints & { resizeMode: string }), audio: false })
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return }
        cameraStreamRef.current = stream
        const videoTrack = stream.getVideoTracks()[0]
        if (videoTrack) {
          try {
            await applySupportedContinuousCameraControls(videoTrack)
          } catch {
            // Keep the camera usable if a browser rejects optional focus/exposure controls.
          }
        }
        const capabilities = videoTrack?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined
        setTorchSupported(Boolean(capabilities?.torch))
        setTorchEnabled(false)
        setTorchMessage(capabilities?.torch ? 'Flashlight available. If the image is dark, try the flashlight or an external light.' : 'This camera or browser does not expose flashlight control.')
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); setCameraReady(true) }
      } catch { setCameraError('Camera access is unavailable. Enable camera permission.'); setCameraReady(false) }
    }
    void startCamera()
    return () => { cancelled = true; cameraStreamRef.current = null; stream?.getTracks().forEach((track) => track.stop()); setTorchEnabled(false); setTorchSupported(false) }
  }, [facingMode, stage])

  useEffect(() => {
    if (stage !== 'capture' || !cameraReady) return
    let animationFrame = 0
    let lastRun = 0
    const tick = (time: number) => {
      if (time - lastRun >= 250) {
        lastRun = time
        const video = videoRef.current
        if (video && video.videoWidth && video.videoHeight) {
          const roi = getEyeRoi(video.videoWidth, video.videoHeight, getCameraFrameAspectRatio(video))
          const canvas = canvasRef.current ?? document.createElement('canvas')
          canvas.width = 160
          canvas.height = Math.max(90, Math.round((roi.height / roi.width) * 160))
          const context = canvas.getContext('2d', { willReadFrequently: true })
          if (context) { context.drawImage(video, roi.left, roi.top, roi.width, roi.height, 0, 0, canvas.width, canvas.height); setMetrics(calculateMetricsFromImageData(context.getImageData(0, 0, canvas.width, canvas.height))) }
        }
      }
      animationFrame = requestAnimationFrame(tick)
    }
    animationFrame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animationFrame)
  }, [cameraReady, stage])

  useEffect(() => {
    if (stage !== 'capture' || !cameraReady) return
    let stopped = false
    let inFlight = false
    const checkEyeState = async () => {
      const video = videoRef.current
      if (stopped || inFlight || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return
      inFlight = true
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 8000)
      try {
        const roi = getEyeRoi(video.videoWidth, video.videoHeight, getCameraFrameAspectRatio(video))
        const frame = document.createElement('canvas')
        frame.width = 224
        frame.height = 224
        const context = frame.getContext('2d')
        if (!context) throw new Error('Eye-state frame could not be prepared.')
        context.drawImage(video, roi.left, roi.top, roi.width, roi.height, 0, 0, 224, 224)
        const prediction = await predictEyeState(frame.toDataURL('image/jpeg', 0.82), controller.signal)
        if (stopped) return
        if (prediction.eye_state === 'closed_eye' && prediction.confidence >= 0.6) {
          openEyeStreakRef.current = 0
          setEyeState('closed')
        } else if (prediction.eye_state === 'open_eye' && prediction.confidence >= 0.75) {
          openEyeStreakRef.current += 1
          setEyeState(openEyeStreakRef.current >= 2 ? 'open' : 'checking')
        } else {
          openEyeStreakRef.current = 0
          setEyeState('checking')
        }
      } catch {
        if (!stopped) { openEyeStreakRef.current = 0; setEyeState('unavailable') }
      } finally {
        window.clearTimeout(timeout)
        inFlight = false
      }
    }
    void checkEyeState()
    const timer = window.setInterval(() => { void checkEyeState() }, 1200)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [cameraReady, stage])

  useEffect(() => {
    if (stage !== 'capture' || !cameraReady || !voiceGuidanceEnabled || !('speechSynthesis' in window)) return
    const guidanceKey = `${guidance.issue}:${guidance.title}`
    const debounce = window.setTimeout(() => {
      if (lastSpokenGuidanceRef.current === guidanceKey) return
      lastSpokenGuidanceRef.current = guidanceKey
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(latestGuidanceRef.current.message)
      utterance.rate = 0.9
      utterance.pitch = 1
      window.speechSynthesis.speak(utterance)
    }, 1600)
    return () => window.clearTimeout(debounce)
  }, [cameraReady, guidance.issue, guidance.title, stage, voiceGuidanceEnabled])

  useEffect(() => {
    if (stage !== 'analyzing') { setElapsedSeconds(0); return }
    const started = Date.now()
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [stage])

  const validatePatient = useCallback((): { age: number; gender: Gender } | null => {
    if (!patientId || !PATIENT_ID_RE.test(patientId)) { setPatientError('Enter a Patient ID with lowercase letters, numbers and hyphens, e.g. patient-042.'); return null }
    const age = Number(ageInput)
    if (!ageInput.trim() || !Number.isInteger(age) || age < 0 || age > 120) { setPatientError('Enter a whole-number age between 0 and 120.'); return null }
    if (!gender) { setPatientError("Select the patient's gender."); return null }
    setPatientError(''); return { age, gender }
  }, [ageInput, gender, patientId])

  const handleStartScan = useCallback(() => { if (!validatePatient()) return; setSaveMessage(''); setImportMessage(''); setFailedSave(null); setStage('capture') }, [validatePatient])

  const runAnalysis = useCallback(async (capture: Capture) => {
    setActiveCapture(capture); setAnalysisError(''); setStage('analyzing')
    const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), analysisTimeoutMs)
    try { const updated = await analyzeCapture(capture.id, controller.signal); setActiveCapture(updated) }
    catch (error) { const aborted = error instanceof DOMException && error.name === 'AbortError'; const reason = aborted ? 'The analysis took too long to respond.' : error instanceof Error && error.message ? error.message : 'The analysis could not be completed.'; setAnalysisError(`${reason} Your photo is saved, so you can retry.`) }
    finally { window.clearTimeout(timeout); setStage('result') }
  }, [])

  const saveScan = useCallback(async (payload: NewCapture) => {
    setSaving(true); setSaveMessage('Saving scan...'); setFailedSaveMessage('')
    try { const capture = await createCapture(payload); setFailedSave(null); setSaveMessage(''); void runAnalysis(capture) }
    catch (error) { setFailedSave(payload); setFailedSaveMessage(error instanceof Error ? error.message : 'The scan could not be saved.'); setSaveMessage('') }
    finally { setSaving(false) }
  }, [runAnalysis])

  const captureSnapshot = useCallback(() => {
    if (eyeState !== 'open') { setSaveMessage('Capture blocked. Please keep your eye open while AnemoScan verifies it.'); return }
    const block = describeBlock(metrics)
    if (!accepted || block) { setSaveMessage(block ?? `Score must reach ${qualityThreshold} before you can capture.`); return }
    const age = Number(ageInput)
    if (!gender || !patientId || !ageInput.trim() || !Number.isInteger(age)) { setStage('patient'); return }
    const video = videoRef.current
    if (!video || video.readyState < 2) { setSaveMessage('Camera frame is not ready yet.'); return }
    const sourceWidth = video.videoWidth || 1280, sourceHeight = video.videoHeight || 720
    const roi = getCaptureRoi(sourceWidth, sourceHeight, getCameraFrameAspectRatio(video))
    const canvas = document.createElement('canvas'); canvas.width = roi.width; canvas.height = roi.height
    const context = canvas.getContext('2d')
    if (!context) { setSaveMessage('Unable to capture this frame.'); return }
    context.drawImage(video, roi.left, roi.top, roi.width, roi.height, 0, 0, roi.width, roi.height)
    void saveScan(toNewCapture(canvas.toDataURL('image/jpeg', 0.92), metrics, patientId, age, gender, cameraLabel))
  }, [accepted, ageInput, cameraLabel, eyeState, gender, metrics, patientId, saveScan])

  const discardFailedSave = useCallback(() => { setFailedSave(null); setFailedSaveMessage('') }, [])
  const handleImportClick = useCallback(() => { setImportMessage(''); if (!validatePatient()) return; fileInputRef.current?.click() }, [validatePatient])
  const handleFileSelected = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    const details = validatePatient(); if (!details) return
    setImporting(true); setImportMessage('')
    try { const { dataUrl, metrics: scored } = await scoreImageFile(file); const block = describeBlock(scored); if (block) { setImportMessage(`This photo cannot be used. ${block}`); return }; await saveScan(toNewCapture(dataUrl, scored, patientId, details.age, details.gender, 'IMPORT')) }
    catch { setImportMessage('Could not read that file as an image.') } finally { setImporting(false) }
  }, [patientId, saveScan, validatePatient])

  const resetScanState = useCallback(() => { setActiveCapture(null); setAnalysisError(''); setFailedSave(null); setFailedSaveMessage(''); setSaveMessage(''); setImportMessage('') }, [])
  const handleRescan = useCallback(() => { resetScanState(); setStage('capture') }, [resetScanState])
  const handleNewPatient = useCallback(() => { resetScanState(); setPatientId(''); setAgeInput(''); setGender(''); setPatientError(''); setStage('patient') }, [resetScanState])
  const retryAnalysis = useCallback(() => { if (activeCapture) void runAnalysis(activeCapture) }, [activeCapture, runAnalysis])

  const glow = useMemo(() => Math.max(0.25, metrics.overall / 100), [metrics.overall])
  const stageLabel = stage === 'patient' ? 'NEW PATIENT' : stage === 'capture' ? 'READY TO CAPTURE' : stage === 'analyzing' ? 'ANALYZING SAMPLE' : 'RESULT READY'
  const captureStatusLine = failedSave ? 'Save failed. Your photo is kept, so retry below.' : saveMessage || guidance.message
  const failedSaveBlock = failedSave ? <div className="mt-3 flex flex-col items-center gap-3"><p className="dialog-error text-center">{failedSaveMessage || 'The scan could not be saved.'}</p><div className="flex gap-3"><button type="button" className="dialog-btn dialog-btn-primary" disabled={saving} onClick={() => void saveScan(failedSave)}><RotateCcw size={16} />Retry save</button><button type="button" className="dialog-btn dialog-btn-ghost" disabled={saving} onClick={discardFailedSave}>Discard</button></div></div> : null

  const patientScreen = <div className="mx-auto w-full max-w-xl"><section className="glass-panel p-5 sm:p-8"><p className="micro-label">STEP 0 · NEW PATIENT</p><h2 className="section-title mb-6">New patient</h2><label className="dialog-label" htmlFor="patient-id">PATIENT ID</label><input id="patient-id" className="dialog-input" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="e.g. patient-042" value={patientId} onChange={(event) => { setPatientId(normalizePatientId(event.target.value)); if (patientError) setPatientError('') }} /><p className="mt-2 text-xs text-cyan-100/60">Use the same ID as in your records. This scan is available only to the current patient session.</p><label className="dialog-label mt-6" htmlFor="patient-age">AGE (YEARS)</label><input id="patient-age" className="dialog-input" type="number" inputMode="numeric" min={0} max={120} placeholder="e.g. 25" value={ageInput} onChange={(event) => { setAgeInput(event.target.value); if (patientError) setPatientError('') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handleStartScan() } }} /><p className="dialog-label mt-6">GENDER</p><div className="grid grid-cols-2 gap-3">{(['female', 'male'] as const).map((option) => <button key={option} type="button" className={`dialog-btn justify-center ${gender === option ? 'dialog-btn-primary' : 'dialog-btn-ghost'}`} aria-pressed={gender === option} onClick={() => { setGender(option); if (patientError) setPatientError('') }}>{capitalize(option)}</button>)}</div>{patientError && <p className="dialog-error">{patientError}</p>}<button type="button" className="dialog-btn dialog-btn-primary mt-7 w-full justify-center" onClick={handleStartScan}><Camera size={16} />Start camera scan</button><button type="button" className="dialog-btn dialog-btn-ghost mt-3 w-full justify-center" disabled={importing || saving} onClick={handleImportClick}>{importing || saving ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}Import a photo instead</button><input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleFileSelected(event)} />{importMessage && <p className="dialog-error">{importMessage}</p>}{failedSaveBlock}<p className="mt-4 text-xs text-cyan-100/60">Age and gender are recorded with the scan for clinical reference; the final image-only classifier uses the conjunctival image.</p></section></div>

  const captureScreen = <><div className="mb-4 flex items-end justify-between gap-4"><div><p className="micro-label">STEP 1 · {patientId.toUpperCase()} · {ageInput} YRS · {gender ? gender.toUpperCase() : ''}</p><h2 className="section-title">LIVE QUALITY MONITOR</h2></div><ThresholdIndicator /></div><div className="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.32fr)_minmax(360px,0.68fr)]"><section className="glass-panel camera-shell p-3 sm:p-4"><div className="camera-frame" style={{ boxShadow: `0 0 ${24 + glow * 36}px rgba(0, 229, 212, ${0.18 + glow * 0.2})` }}><video ref={videoRef} className="camera-video" style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'none' }} playsInline muted autoPlay />{!cameraReady && <div className="camera-fallback"><Camera size={42} /><span>{cameraError || 'Initializing camera feed'}</span></div>}<div className="camera-grid" /><div className="corner corner-tl" /><div className="corner corner-tr" /><div className="corner corner-bl" /><div className="corner corner-br" /><div className="live-badge">LIVE</div><div className="eye-guide" aria-hidden="true"><div className="eye-guide-label">ONE EYE / CONJUNCTIVA</div></div><ScoreDisplay value={metrics.overall} /></div><div className="mt-5 flex flex-wrap items-center justify-center gap-4"><button className="round-control" type="button" aria-label="Switch camera" onClick={() => setFacingMode((current) => current === 'environment' ? 'user' : 'environment')}><FlipHorizontal2 size={22} /></button><button className="round-control" type="button" aria-label={voiceGuidanceEnabled ? 'Turn off spoken guidance' : 'Turn on spoken guidance'} aria-pressed={voiceGuidanceEnabled} onClick={() => { if (!voiceGuidanceEnabled) { lastSpokenGuidanceRef.current = ''; setVoiceGuidanceEnabled(true) } else { setVoiceGuidanceEnabled(false); window.speechSynthesis?.cancel() } }}>{voiceGuidanceEnabled ? <Volume2 size={22} /> : <VolumeX size={22} />}</button><button className={`round-control torch-control ${torchEnabled ? 'torch-on' : ''}`} type="button" aria-label={torchEnabled ? 'Turn flashlight off' : 'Turn flashlight on'} aria-pressed={torchEnabled} disabled={!torchSupported || torchRequestRef.current} title={torchMessage} onClick={() => { const track = cameraStreamRef.current?.getVideoTracks()[0]; if (!track || torchRequestRef.current) return; const nextEnabled = !torchEnabled; torchRequestRef.current = true; void track.applyConstraints({ advanced: [{ torch: nextEnabled } as MediaTrackConstraintSet] }).then(() => { setTorchEnabled(nextEnabled); setTorchMessage(nextEnabled ? 'Flashlight is ON. Tap again to turn it off.' : 'Flashlight is OFF.') }).catch(() => { setTorchEnabled(false); setTorchMessage('Flashlight control is unavailable on this camera. Use an external light source.') }).finally(() => { torchRequestRef.current = false }) }}><Flashlight size={22} /><span className="torch-state">{torchEnabled ? 'ON' : 'OFF'}</span></button><button className="shutter" type="button" aria-label={accepted ? 'Capture image' : 'Capture locked: framing or quality not met'} disabled={saving || !!failedSave || !accepted || !cameraReady} onClick={captureSnapshot}><span /></button><div className="camera-label"><span>{cameraLabel}</span><small>CAMERA</small></div></div><div className={`capture-guidance ${guidance.ready && !failedSave ? 'ready' : 'warning'}`} role="status" aria-live="polite"><div className="capture-guidance-heading">{guidance.ready && !failedSave ? <CheckCircle2 size={17} /> : <ShieldAlert size={17} />}<strong>{failedSave ? 'Save failed' : saveMessage ? 'Please wait' : guidance.title}</strong></div><p>{captureStatusLine}</p><small>{guidance.detail}</small></div>{failedSaveBlock}<button type="button" className="mx-auto mt-4 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-200/70 transition-colors hover:text-cyan-200" onClick={() => setStage('patient')}><span>Edit patient details</span></button></section><aside className="glass-panel analysis-panel p-4 sm:p-5"><div className="mb-5 flex items-center justify-between gap-4"><div><p className="micro-label">ANALYSIS</p><h2 className="panel-title">Image Quality</h2></div><div className={`status-chip ${accepted ? 'ready' : 'warning'}`}>{accepted ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}{status}</div></div><div className="space-y-5"><MetricBar label="BRIGHTNESS" value={metrics.brightness} /><MetricBar label="SHARPNESS" value={metrics.sharpness} /><MetricBar label="CONTRAST" value={metrics.contrast} /></div><div className="overall-orb" style={{ boxShadow: `0 0 ${20 + glow * 54}px rgba(60, 255, 143, ${0.12 + glow * 0.32})` }}><div><span>OVERALL</span><strong>{round(metrics.overall)}</strong></div><ScanLine size={36} /></div></aside></div></>

  const analyzingScreen = <div className="mx-auto w-full max-w-xl"><section className="glass-panel p-5 text-center sm:p-8">{activeCapture && <div className="dialog-preview"><img src={imageUrl(activeCapture)} alt="Captured scan" /></div>}<Loader2 size={40} className="mx-auto animate-spin text-cyan-200" /><h2 className="panel-title mt-4">Analyzing sample...</h2><p className="mt-2 text-sm text-cyan-100/70">{elapsedSeconds >= 8 ? 'Waking up the analysis service. The first scan can take up to a minute.' : 'Running the binary anemia classifier on your photo.'}</p><p className="micro-label mt-4">{elapsedSeconds}s</p></section></div>

  const resultReady = !analysisError && activeCapture?.anemiaProbability != null
  const isAnemia = activeCapture?.anemiaDetected === true
  const resultScreen = <div className="mx-auto w-full max-w-3xl"><section className="glass-panel p-5 sm:p-8"><p className="micro-label">SCAN COMPLETE</p><h2 className="section-title mb-1">Screening result</h2>{activeCapture && <p className="mb-5 text-sm text-cyan-100/70">{activeCapture.name}</p>}<div className="grid items-start gap-5 sm:grid-cols-2">{activeCapture ? <div className="dialog-preview"><img src={imageUrl(activeCapture)} alt="Captured scan" /></div> : <div />}{resultReady && activeCapture ? <div><div className="overall-orb"><div><span>ANEMIA PROBABILITY</span><strong>{Math.round((activeCapture.anemiaProbability ?? 0) * 100)}%</strong></div><span>MODEL THRESHOLD 50%</span></div><div className={`status-chip ${isAnemia ? 'warning' : 'ready'}`}>{isAnemia ? <ShieldAlert size={16} /> : <CheckCircle2 size={16} />}{activeCapture.anemiaStatus}</div><p className="mt-4 text-sm text-cyan-100/70">Patient {activeCapture.patientId}: {activeCapture.age} years · {capitalize(activeCapture.gender ?? '')}</p></div> : <div><div className="status-chip warning"><ShieldAlert size={16} />ANALYSIS FAILED</div><p className="dialog-error mt-3">{analysisError || 'The analysis could not be completed.'}</p><button type="button" className="dialog-btn dialog-btn-primary mt-4" onClick={retryAnalysis}><RotateCcw size={16} />Retry analysis</button></div>}</div><p className="mt-5 text-xs text-cyan-100/60">Screening result only. Confirm with a laboratory hemoglobin test; this prototype is not a diagnosis.</p><div className="mt-6 flex flex-wrap items-center justify-end gap-3"><button type="button" className="dialog-btn dialog-btn-ghost" onClick={handleRescan}><Camera size={16} />Rescan this patient</button><button type="button" className="dialog-btn dialog-btn-primary" onClick={handleNewPatient}><UserPlus size={16} />New patient</button></div></section></div>

  return <main className="min-h-screen overflow-hidden bg-[#050A14] text-cyan-50"><div className="fixed inset-0 pointer-events-none bg-[radial-gradient(circle_at_18%_10%,rgba(0,229,212,0.18),transparent_30%),radial-gradient(circle_at_86%_26%,rgba(60,255,143,0.12),transparent_26%),linear-gradient(135deg,rgba(5,10,20,1),rgba(5,10,20,0.86))]" /><div className="fixed inset-0 pointer-events-none opacity-[0.13] scan-field" /><section className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-6 lg:px-8"><header className="glass-panel header-grid mb-6 flex items-center justify-between gap-4 px-4 py-3"><div className="flex items-center gap-3"><div className="icon-cell" aria-label="AnemoScan"><img src="/anemoscan-mark.svg" alt="AnemoScan" style={{ width: 32, height: 32, objectFit: 'contain' }} /></div><div><p className="micro-label">AI CONJUNCTIVA IMAGE QUALITY SYSTEM</p><h1 className="title-text">ANEMOSCAN IQA MONITOR</h1></div></div><StatusIndicator label={stageLabel} /></header>{stage === 'patient' && patientScreen}{stage === 'capture' && captureScreen}{stage === 'analyzing' && analyzingScreen}{stage === 'result' && resultScreen}</section><canvas ref={canvasRef} className="hidden" /></main>
}

function StatusIndicator({ label }: { label: string }) { return <div className="system-status"><span />{label}</div> }
function ThresholdIndicator() { return <div className="threshold-card"><span>Min required: {qualityThreshold} / 100</span><small>Shutter locked below this score</small></div> }
function MetricBar({ label, value }: { label: string; value: number }) { return <div className="metric"><div className="mb-2 flex items-center justify-between"><span>{label}</span><strong>{round(value)}</strong></div><div className="metric-track"><div className="metric-fill" style={{ transform: `scaleX(${clamp(value) / 100})` }} /></div></div> }
function ScoreDisplay({ value }: { value: number }) { return <div className="score-display"><strong>{round(value)}</strong><span>SCORE</span></div> }
