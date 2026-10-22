import {
  Camera,
  CheckCircle2,
  FlipHorizontal2,
  Loader2,
  RotateCcw,
  ScanLine,
  ShieldAlert,
  Upload,
  UserPlus,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'

import { analyzeCapture, createCapture, imageUrl } from './lib/api'
import type { Capture, Gender, NewCapture } from './lib/api'

const qualityThreshold = 65
const analysisTimeoutMs = 90_000
const maxImportSide = 1280

type FacingMode = 'user' | 'environment'
type DistanceStatus = 'too-far' | 'too-close' | 'no-eye' | 'good'
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

const MIN_SKIN_RATIO = 0.05
const MAX_SKIN_RATIO = 0.82
const MIN_SCLERA_RATIO = 0.035
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

function getEyeRoi(width: number, height: number) {
  const roiWidth = Math.round(width * 0.72)
  const roiHeight = Math.round(height * 0.58)
  const left = Math.round((width - roiWidth) / 2)
  const top = Math.round((height - roiHeight) / 2)
  return { left, top, width: roiWidth, height: roiHeight }
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
  let distanceStatus: DistanceStatus
  if (skinRatio < MIN_SKIN_RATIO) distanceStatus = 'too-far'
  else if (skinRatio > MAX_SKIN_RATIO) distanceStatus = 'too-close'
  else if (scleraRatio < MIN_SCLERA_RATIO) distanceStatus = 'no-eye'
  else distanceStatus = 'good'
  return { brightness, sharpness, contrast, overall, distanceStatus, skinRatio, scleraRatio }
}

function describeBlock(metrics: Metrics): string | null {
  if (metrics.distanceStatus === 'too-far') return 'Subject is too far away. Move closer.'
  if (metrics.distanceStatus === 'too-close') return 'Subject is too close. Move back.'
  if (metrics.distanceStatus === 'no-eye') return 'Position the eye clearly in frame. The white of the eye must be visible.'
  if (metrics.overall < qualityThreshold) return `Quality score ${round(metrics.overall)} is below the required ${qualityThreshold}.`
  return null
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
    const roi = getEyeRoi(width, height)
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
  const [facingMode, setFacingMode] = useState<FacingMode>('environment')
  const [metrics, setMetrics] = useState<Metrics>(initialMetrics)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')

  const qualityOk = metrics.overall >= qualityThreshold
  const distanceOk = metrics.distanceStatus === 'good'
  const accepted = qualityOk && distanceOk
  const status = accepted ? 'READY' : 'LOW QUALITY'
  const cameraLabel = facingMode === 'user' ? 'FRONT' : 'BACK'

  useEffect(() => {
    if (stage !== 'capture') return
    let stream: MediaStream | null = null
    let cancelled = false
    async function startCamera() {
      setCameraReady(false); setCameraError(''); setMetrics(initialMetrics)
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return }
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); setCameraReady(true) }
      } catch { setCameraError('Camera access is unavailable. Enable camera permission.'); setCameraReady(false) }
    }
    void startCamera()
    return () => { cancelled = true; stream?.getTracks().forEach((track) => track.stop()) }
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
          const roi = getEyeRoi(video.videoWidth, video.videoHeight)
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
    const block = describeBlock(metrics)
    if (!accepted || block) { setSaveMessage(block ?? `Score must reach ${qualityThreshold} before you can capture.`); return }
    const age = Number(ageInput)
    if (!gender || !patientId || !ageInput.trim() || !Number.isInteger(age)) { setStage('patient'); return }
    const video = videoRef.current
    if (!video || video.readyState < 2) { setSaveMessage('Camera frame is not ready yet.'); return }
    const sourceWidth = video.videoWidth || 1280, sourceHeight = video.videoHeight || 720
    const roi = getEyeRoi(sourceWidth, sourceHeight)
    const canvas = document.createElement('canvas'); canvas.width = roi.width; canvas.height = roi.height
    const context = canvas.getContext('2d')
    if (!context) { setSaveMessage('Unable to capture this frame.'); return }
    context.drawImage(video, roi.left, roi.top, roi.width, roi.height, 0, 0, roi.width, roi.height)
    void saveScan(toNewCapture(canvas.toDataURL('image/jpeg', 0.92), metrics, patientId, age, gender, cameraLabel))
  }, [accepted, ageInput, cameraLabel, gender, metrics, patientId, saveScan])

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
  const captureStatusLine = failedSave ? 'Save failed. Your photo is kept, so retry below' : saveMessage || (accepted ? 'Press the shutter. The scan is saved and analyzed automatically' : metrics.distanceStatus === 'too-far' ? 'Too far: move closer' : metrics.distanceStatus === 'too-close' ? 'Too close: move back' : metrics.distanceStatus === 'no-eye' ? 'Center one open eye inside the guide' : `Score must reach ${qualityThreshold} to unlock capture`)
  const failedSaveBlock = failedSave ? <div className="mt-3 flex flex-col items-center gap-3"><p className="dialog-error text-center">{failedSaveMessage || 'The scan could not be saved.'}</p><div className="flex gap-3"><button type="button" className="dialog-btn dialog-btn-primary" disabled={saving} onClick={() => void saveScan(failedSave)}><RotateCcw size={16} />Retry save</button><button type="button" className="dialog-btn dialog-btn-ghost" disabled={saving} onClick={discardFailedSave}>Discard</button></div></div> : null

  const patientScreen = <div className="mx-auto w-full max-w-xl"><section className="glass-panel p-5 sm:p-8"><p className="micro-label">STEP 0 · NEW PATIENT</p><h2 className="section-title mb-6">New patient</h2><label className="dialog-label" htmlFor="patient-id">PATIENT ID</label><input id="patient-id" className="dialog-input" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="e.g. patient-042" value={patientId} onChange={(event) => { setPatientId(normalizePatientId(event.target.value)); if (patientError) setPatientError('') }} /><p className="mt-2 text-xs text-cyan-100/60">Use the same ID as in your records. This scan is available only to the current patient session.</p><label className="dialog-label mt-6" htmlFor="patient-age">AGE (YEARS)</label><input id="patient-age" className="dialog-input" type="number" inputMode="numeric" min={0} max={120} placeholder="e.g. 25" value={ageInput} onChange={(event) => { setAgeInput(event.target.value); if (patientError) setPatientError('') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handleStartScan() } }} /><p className="dialog-label mt-6">GENDER</p><div className="grid grid-cols-2 gap-3">{(['female', 'male'] as const).map((option) => <button key={option} type="button" className={`dialog-btn justify-center ${gender === option ? 'dialog-btn-primary' : 'dialog-btn-ghost'}`} aria-pressed={gender === option} onClick={() => { setGender(option); if (patientError) setPatientError('') }}>{capitalize(option)}</button>)}</div>{patientError && <p className="dialog-error">{patientError}</p>}<button type="button" className="dialog-btn dialog-btn-primary mt-7 w-full justify-center" onClick={handleStartScan}><Camera size={16} />Start camera scan</button><button type="button" className="dialog-btn dialog-btn-ghost mt-3 w-full justify-center" disabled={importing || saving} onClick={handleImportClick}>{importing || saving ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}Import a photo instead</button><input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleFileSelected(event)} />{importMessage && <p className="dialog-error">{importMessage}</p>}{failedSaveBlock}<p className="mt-4 text-xs text-cyan-100/60">Age and gender are recorded with the scan for clinical reference; the final image-only classifier uses the conjunctival image.</p></section></div>

  const captureScreen = <><div className="mb-4 flex items-end justify-between gap-4"><div><p className="micro-label">STEP 1 · {patientId.toUpperCase()} · {ageInput} YRS · {gender ? gender.toUpperCase() : ''}</p><h2 className="section-title">LIVE QUALITY MONITOR</h2></div><ThresholdIndicator /></div><div className="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.32fr)_minmax(360px,0.68fr)]"><section className="glass-panel camera-shell p-3 sm:p-4"><div className="camera-frame" style={{ boxShadow: `0 0 ${24 + glow * 36}px rgba(0, 229, 212, ${0.18 + glow * 0.2})` }}><video ref={videoRef} className="camera-video" style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'none' }} playsInline muted autoPlay />{!cameraReady && <div className="camera-fallback"><Camera size={42} /><span>{cameraError || 'Initializing camera feed'}</span></div>}<div className="camera-grid" /><div className="corner corner-tl" /><div className="corner corner-tr" /><div className="corner corner-bl" /><div className="corner corner-br" /><div className="live-badge">LIVE</div><div className="eye-guide" aria-hidden="true"><div className="eye-guide-label">ONE EYE / CONJUNCTIVA</div></div><ScoreDisplay value={metrics.overall} /></div><div className="mt-5 flex items-center justify-center gap-5"><button className="round-control" type="button" aria-label="Switch camera" onClick={() => setFacingMode((current) => current === 'environment' ? 'user' : 'environment')}><FlipHorizontal2 size={22} /></button><button className="shutter" type="button" aria-label={accepted ? 'Capture image' : 'Capture locked: framing or quality not met'} disabled={saving || !!failedSave || !accepted} onClick={captureSnapshot}><span /></button><div className="camera-label"><span>{cameraLabel}</span><small>CAMERA</small></div></div><div className="mt-4 flex min-h-6 items-center justify-center gap-2 text-center text-xs uppercase tracking-[0.24em] text-cyan-100/70">{saving ? <Loader2 size={14} className="animate-spin" /> : accepted && !failedSave ? <ScanLine size={14} /> : <ShieldAlert size={14} className="text-amber-300" />}<span>{captureStatusLine}</span></div>{failedSaveBlock}<button type="button" className="mx-auto mt-4 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-200/70 transition-colors hover:text-cyan-200" onClick={() => setStage('patient')}><span>Edit patient details</span></button></section><aside className="glass-panel analysis-panel p-4 sm:p-5"><div className="mb-5 flex items-center justify-between gap-4"><div><p className="micro-label">ANALYSIS</p><h2 className="panel-title">Image Quality</h2></div><div className={`status-chip ${accepted ? 'ready' : 'warning'}`}>{accepted ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}{status}</div></div><div className="space-y-5"><MetricBar label="BRIGHTNESS" value={metrics.brightness} /><MetricBar label="SHARPNESS" value={metrics.sharpness} /><MetricBar label="CONTRAST" value={metrics.contrast} /></div><div className="overall-orb" style={{ boxShadow: `0 0 ${20 + glow * 54}px rgba(60, 255, 143, ${0.12 + glow * 0.32})` }}><div><span>OVERALL</span><strong>{round(metrics.overall)}</strong></div><ScanLine size={36} /></div></aside></div></>

  const analyzingScreen = <div className="mx-auto w-full max-w-xl"><section className="glass-panel p-5 text-center sm:p-8">{activeCapture && <div className="dialog-preview"><img src={imageUrl(activeCapture)} alt="Captured scan" /></div>}<Loader2 size={40} className="mx-auto animate-spin text-cyan-200" /><h2 className="panel-title mt-4">Analyzing sample...</h2><p className="mt-2 text-sm text-cyan-100/70">{elapsedSeconds >= 8 ? 'Waking up the analysis service. The first scan can take up to a minute.' : 'Running the binary anemia classifier on your photo.'}</p><p className="micro-label mt-4">{elapsedSeconds}s</p></section></div>

  const resultReady = !analysisError && activeCapture?.anemiaProbability != null
  const isAnemia = activeCapture?.anemiaDetected === true
  const resultScreen = <div className="mx-auto w-full max-w-3xl"><section className="glass-panel p-5 sm:p-8"><p className="micro-label">SCAN COMPLETE</p><h2 className="section-title mb-1">Screening result</h2>{activeCapture && <p className="mb-5 text-sm text-cyan-100/70">{activeCapture.name}</p>}<div className="grid items-start gap-5 sm:grid-cols-2">{activeCapture ? <div className="dialog-preview"><img src={imageUrl(activeCapture)} alt="Captured scan" /></div> : <div />}{resultReady && activeCapture ? <div><div className="overall-orb"><div><span>ANEMIA PROBABILITY</span><strong>{Math.round((activeCapture.anemiaProbability ?? 0) * 100)}%</strong></div><span>MODEL THRESHOLD 50%</span></div><div className={`status-chip ${isAnemia ? 'warning' : 'ready'}`}>{isAnemia ? <ShieldAlert size={16} /> : <CheckCircle2 size={16} />}{activeCapture.anemiaStatus}</div><p className="mt-4 text-sm text-cyan-100/70">Patient {activeCapture.patientId}: {activeCapture.age} years · {capitalize(activeCapture.gender ?? '')}</p></div> : <div><div className="status-chip warning"><ShieldAlert size={16} />ANALYSIS FAILED</div><p className="dialog-error mt-3">{analysisError || 'The analysis could not be completed.'}</p><button type="button" className="dialog-btn dialog-btn-primary mt-4" onClick={retryAnalysis}><RotateCcw size={16} />Retry analysis</button></div>}</div><p className="mt-5 text-xs text-cyan-100/60">Screening result only. Confirm with a laboratory hemoglobin test; this prototype is not a diagnosis.</p><div className="mt-6 flex flex-wrap items-center justify-end gap-3"><button type="button" className="dialog-btn dialog-btn-ghost" onClick={handleRescan}><Camera size={16} />Rescan this patient</button><button type="button" className="dialog-btn dialog-btn-primary" onClick={handleNewPatient}><UserPlus size={16} />New patient</button></div></section></div>

  return <main className="min-h-screen overflow-hidden bg-[#050A14] text-cyan-50"><div className="fixed inset-0 pointer-events-none bg-[radial-gradient(circle_at_18%_10%,rgba(0,229,212,0.18),transparent_30%),radial-gradient(circle_at_86%_26%,rgba(60,255,143,0.12),transparent_26%),linear-gradient(135deg,rgba(5,10,20,1),rgba(5,10,20,0.86))]" /><div className="fixed inset-0 pointer-events-none opacity-[0.13] scan-field" /><section className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-6 lg:px-8"><header className="glass-panel header-grid mb-6 flex items-center justify-between gap-4 px-4 py-3"><div className="flex items-center gap-3"><div className="icon-cell" aria-label="AnemoScan"><svg viewBox="0 0 320 220" role="img" aria-label="AnemoScan eye scan mark" style={{ width: 32, height: 24 }}><defs><linearGradient id="patient-logo-eye" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#00E5FF" /><stop offset="1" stopColor="#1677FF" /></linearGradient><linearGradient id="patient-logo-accent" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#39FF6A" /><stop offset="1" stopColor="#00E5D4" /></linearGradient></defs><path d="M18 52V18h34M268 18h34v34M18 168v34h34M302 168v-34" fill="none" stroke="url(#patient-logo-accent)" strokeWidth="10" strokeLinecap="round" /><path d="M38 110c38-54 86-72 122-72s84 18 122 72c-38 54-86 72-122 72S76 164 38 110Z" fill="none" stroke="url(#patient-logo-eye)" strokeWidth="14" /><circle cx="160" cy="110" r="49" fill="#07111f" stroke="url(#patient-logo-eye)" strokeWidth="10" /><circle cx="160" cy="110" r="22" fill="url(#patient-logo-accent)" /><circle cx="168" cy="102" r="7" fill="#e1fffc" /></svg></div><div><p className="micro-label">AI CONJUNCTIVA IMAGE QUALITY SYSTEM</p><h1 className="title-text">ANEMOSCAN IQA MONITOR</h1></div></div><StatusIndicator label={stageLabel} /></header>{stage === 'patient' && patientScreen}{stage === 'capture' && captureScreen}{stage === 'analyzing' && analyzingScreen}{stage === 'result' && resultScreen}</section><canvas ref={canvasRef} className="hidden" /></main>
}

function StatusIndicator({ label }: { label: string }) { return <div className="system-status"><span />{label}</div> }
function ThresholdIndicator() { return <div className="threshold-card"><span>Min required: {qualityThreshold} / 100</span><small>Shutter locked below this score</small></div> }
function MetricBar({ label, value }: { label: string; value: number }) { return <div className="metric"><div className="mb-2 flex items-center justify-between"><span>{label}</span><strong>{round(value)}</strong></div><div className="metric-track"><div className="metric-fill" style={{ transform: `scaleX(${clamp(value) / 100})` }} /></div></div> }
function ScoreDisplay({ value }: { value: number }) { return <div className="score-display"><strong>{round(value)}</strong><span>SCORE</span></div> }
