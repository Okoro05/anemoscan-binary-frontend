export const ANATOMICAL_CLASSES = [
  'closed_eye',
  'open_eye_no_conjunctiva',
  'partial_conjunctiva',
  'conjunctiva_visible',
  'unusable_image',
] as const

export type AnatomicalClass = (typeof ANATOMICAL_CLASSES)[number]

export type AnatomicalPrediction = {
  className: AnatomicalClass
  confidence: number
  secondBestConfidence: number
}

export type AnatomicalGateResult =
  | { status: 'accepted'; className: 'conjunctiva_visible'; confidence: number }
  | { status: 'rejected'; className: Exclude<AnatomicalClass, 'conjunctiva_visible'>; confidence: number }
  | { status: 'uncertain'; reason: 'low_confidence' | 'ambiguous_prediction' | 'invalid_prediction' }

/**
 * Converts a trained model's output into a conservative capture decision.
 *
 * This function is deliberately not an image classifier. It must only be used
 * with predictions from a separately trained and validated anatomical model.
 * Brightness, sharpness, sclera colour, or generic face landmarks are not
 * substitutes for detecting visible lower palpebral conjunctiva.
 */
export function validateAnatomicalPrediction(
  prediction: AnatomicalPrediction,
  minimumConfidence = 0.9,
  minimumMargin = 0.2,
): AnatomicalGateResult {
  const validClass = ANATOMICAL_CLASSES.includes(prediction.className)
  const validConfidence =
    Number.isFinite(prediction.confidence) &&
    prediction.confidence >= 0 &&
    prediction.confidence <= 1
  const validSecond =
    Number.isFinite(prediction.secondBestConfidence) &&
    prediction.secondBestConfidence >= 0 &&
    prediction.secondBestConfidence <= 1

  if (!validClass || !validConfidence || !validSecond) {
    return { status: 'uncertain', reason: 'invalid_prediction' }
  }

  if (prediction.confidence < minimumConfidence) {
    return { status: 'uncertain', reason: 'low_confidence' }
  }

  if (prediction.confidence - prediction.secondBestConfidence < minimumMargin) {
    return { status: 'uncertain', reason: 'ambiguous_prediction' }
  }

  if (prediction.className === 'conjunctiva_visible') {
    return {
      status: 'accepted',
      className: 'conjunctiva_visible',
      confidence: prediction.confidence,
    }
  }

  return {
    status: 'rejected',
    className: prediction.className,
    confidence: prediction.confidence,
  }
}
