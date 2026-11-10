/**
 * Distance policy: this module does not estimate physical camera distance.
 * Do not issue "move closer" or "move farther" instructions from skin/sclera
 * colour ratios. Eye-size/framing calibration must be implemented and validated
 * against the approved reference capture before distance guidance is enabled.
 * Until then, this module reports only image quality and a limited no-eye hint.
 */
export type CaptureQualityMetrics = {
  brightness: number
  sharpness: number
  contrast: number
  overall: number
  distanceStatus: 'no-eye' | 'good'
}

export type CaptureGuidance = {
  issue: 'camera' | 'no-eye' | 'framing' | 'brightness' | 'sharpness' | 'contrast' | 'score' | 'ready'
  title: string
  message: string
  detail: string
  ready: boolean
}

export const CAPTURE_QUALITY_THRESHOLD = 65

/**
 * Converts the existing live quality measurements into one clear instruction.
 * The component reports the first actionable problem so users are not given
 * several conflicting instructions at once.
 *
 * Brightness, sharpness and contrast cutoffs are provisional heuristics. They
 * should be calibrated against representative images from the actual camera.
 */
export function getCaptureGuidance(
  metrics: CaptureQualityMetrics,
  cameraReady: boolean,
  saving = false,
): CaptureGuidance {
  if (!cameraReady) {
    return {
      issue: 'camera',
      title: 'Camera not ready',
      message: 'Please wait while the camera starts.',
      detail: 'The live image is not available yet.',
      ready: false,
    }
  }

  if (saving) {
    return {
      issue: 'camera',
      title: 'Saving image',
      message: 'Please hold still while we save your image.',
      detail: 'Do not move the camera until saving is complete.',
      ready: false,
    }
  }

  if (metrics.distanceStatus === 'no-eye') {
    return {
      issue: 'no-eye',
      title: 'No visible eye detected',
      message: 'No visible eye detected. Position one eye inside the camera guide.',
      detail: 'The current check is a basic visual-presence heuristic. It does not confirm that the lower palpebral conjunctiva is exposed.',
      ready: false,
    }
  }

  if (metrics.brightness < 35) {
    return {
      issue: 'brightness',
      title: 'Image too dark',
      message: 'The image is too dark. Try turning on the flashlight or using an external light source.',
      detail: `Brightness is ${Math.round(metrics.brightness)}/100. The flashlight will not turn on automatically. Improve the lighting, then wait for the score to update.`,
      ready: false,
    }
  }

  if (metrics.brightness > 82) {
    return {
      issue: 'brightness',
      title: 'Too much light',
      message: 'The image is too bright. Reduce the light or move away from glare.',
      detail: `Brightness is ${Math.round(metrics.brightness)}/100. Avoid direct light reflecting into the camera.`,
      ready: false,
    }
  }

  if (metrics.sharpness < 30) {
    return {
      issue: 'sharpness',
      title: 'Image is blurry',
      message: 'The image is blurry. Hold the camera steady and allow the eye to come into focus.',
      detail: `Sharpness is ${Math.round(metrics.sharpness)}/100.`,
      ready: false,
    }
  }

  if (metrics.contrast < 20) {
    return {
      issue: 'contrast',
      title: 'Low image contrast',
      message: 'The image has low contrast. Adjust the lighting and reposition the camera.',
      detail: `Contrast is ${Math.round(metrics.contrast)}/100.`,
      ready: false,
    }
  }

  if (metrics.overall < CAPTURE_QUALITY_THRESHOLD) {
    const weakest = [
      { key: 'brightness' as const, value: metrics.brightness, label: 'Lighting', instruction: 'Adjust the lighting so the eye is clearly visible.' },
      { key: 'sharpness' as const, value: metrics.sharpness, label: 'Focus', instruction: 'Hold the camera steady and allow the eye to come into focus.' },
      { key: 'contrast' as const, value: metrics.contrast, label: 'Contrast', instruction: 'Adjust the lighting and reposition the camera.' },
    ].sort((a, b) => a.value - b.value)[0]

    return {
      issue: 'score',
      title: 'Image quality below 65',
      message: `Your image score is ${Math.round(metrics.overall)}/100. ${weakest.instruction}`,
      detail: `${weakest.label} is currently the lowest quality check at ${Math.round(weakest.value)}/100. The required score is 65/100.`,
      ready: false,
    }
  }

  return {
    issue: 'ready',
    title: 'Image quality accepted',
    message: `Good. Image quality is ${Math.round(metrics.overall)}/100. Hold still while we capture your image.`,
    detail: 'Image-quality checks passed. This score does not verify conjunctiva exposure or physical camera distance. Confirm the lower palpebral conjunctiva is visible before proceeding.',
    ready: true,
  }
}
