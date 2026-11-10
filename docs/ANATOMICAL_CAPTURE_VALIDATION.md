# AnemoScan anatomical capture validation

## Purpose

This module must verify that a captured frame contains the lower palpebral conjunctiva, not merely a bright eye-shaped region. It is separate from the anemia classifier and from the 65/100 image-quality score.

## Why a dedicated model is required

The current frontend calculates brightness, sharpness, contrast and rough pixel ratios. Those measurements cannot reliably distinguish:
- a closed eyelid from an open eye;
- an open eye with the lower lid in its normal position;
- a lower eyelid gently pulled down with the palpebral conjunctiva exposed;
- a reflection or pale background that resembles conjunctival tissue.

A face-landmark model can locate facial landmarks, but the current capture is a close-up eye crop. Face-level landmarks alone do not prove that the target conjunctiva is visible. Do not treat those landmarks or white-pixel ratios as anatomical confirmation.

## Required image labels

Each frame should receive exactly one primary label:

| Label | Meaning | Capture decision |
|---|---|---|
| `no_eye` | No usable eye in the frame | Reject |
| `eye_closed` | Eyelids closed | Reject |
| `eye_partly_open` | Eye is open only slightly or is blinking | Reject and ask user to open eye |
| `open_no_conjunctiva` | Eye is open, but lower palpebral conjunctiva is not exposed | Reject and ask user to gently pull down lower lid |
| `conjunctiva_partial` | Some target tissue is visible, but not enough for reliable analysis | Reject and ask user to expose more of the lower lid |
| `conjunctiva_visible` | Lower palpebral conjunctiva is clearly exposed and sufficiently framed | Continue to image-quality checks |
| `obstructed` | Target is blocked by lashes, fingers, makeup, reflections or another obstruction | Reject and explain the obstruction |
| `unusable` | Severe blur, glare, over/underexposure or motion | Reject and defer to quality guidance |

For `conjunctiva_visible`, annotators should also draw a polygon mask around the visible lower palpebral conjunctiva. Do not label the sclera (the white of the eye), skin, eyelid margin or tear film as conjunctiva.

## Data collection requirements

Collect examples from the same kind of close-up camera framing used by the deployed app. Include:
- open and closed eyes;
- normal lower eyelid position with no conjunctiva exposed;
- partial and clearly exposed lower palpebral conjunctiva;
- different skin tones, ages, eye shapes and camera devices;
- different lighting, distances, focus levels and orientations;
- common obstructions and reflections.

The existing anemia dataset may contain only already-captured conjunctival images. If so, it cannot by itself teach the model to reject closed eyes or ordinary eye photographs. Add representative negative examples. Obtain appropriate consent and remove direct identifiers. Keep all images from one participant in only one dataset split to prevent leakage.

## Model design

Use a two-part anatomical validator:
1. An image-level classifier for the eight states above.
2. A segmentation model that marks the lower palpebral conjunctiva when the classifier predicts `conjunctiva_visible`.

The live capture gate should require:
- classifier confidence above a threshold selected on a held-out validation set;
- `conjunctiva_visible` as the predicted state;
- a sufficiently large, contiguous conjunctiva mask in the capture region;
- stable valid predictions across multiple consecutive frames;
- all existing image-quality checks passing (including the 65/100 threshold).

If the model is missing, fails to load, or is uncertain, the anatomical gate must return `not_verified`, never `valid`. Do not send an unverified frame to anemia inference once this gate is enabled.

## Validation before enabling the gate

Report per-class precision, recall and confusion matrix, plus sensitivity for rejecting invalid frames. Test on participants and camera sessions not used for training. Pay particular attention to false acceptance of `eye_closed`, `open_no_conjunctiva` and `conjunctiva_partial`. Thresholds must be selected using held-out data, not guessed.

## Live instruction mapping

- `no_eye`: "Please position one eye inside the camera guide."
- `eye_closed`: "Please open your eye."
- `eye_partly_open`: "Please open your eye fully and hold still."
- `open_no_conjunctiva`: "Gently pull down your lower eyelid to expose the inner surface."
- `conjunctiva_partial`: "Please pull your lower eyelid down a little further."
- `obstructed`: "Please move anything blocking the lower eyelid area."
- `unusable`: Hand over to the specific brightness, glare, focus or framing instruction.
- `conjunctiva_visible`: "Good. Keep your lower eyelid in position while we check image quality."

## Integration boundary

The anatomical validator must return a typed result such as:

```ts
type AnatomyState =
  | 'not_verified'
  | 'no_eye'
  | 'eye_closed'
  | 'eye_partly_open'
  | 'open_no_conjunctiva'
  | 'conjunctiva_partial'
  | 'conjunctiva_visible'
  | 'obstructed'
  | 'unusable'

type AnatomyResult = {
  state: AnatomyState
  confidence: number
  conjunctivaAreaRatio?: number
  stableFrames: number
}
```

Only the validated model adapter should produce `conjunctiva_visible`. Pixel heuristics, manual assertions and general face landmarks must not manufacture that state.


## Reference framing and distance policy

The operator-supplied patient-019 close-up is the visual framing reference for this capture interface. The live guide and saved analysis crop must use the same geometry so the image being evaluated is the image being captured. The current guide is a wide eye window occupying 76% of the preview width and 70% of its height, positioned 12% from the left and 15% from the top.

This is a **framing target**, not a measurement in centimetres. Physical camera distance varies with camera focal length, sensor size, zoom and device. Do not tell the operator to move closer or farther using skin-colour or sclera-pixel ratios. Distance guidance must be driven by a validated eye-region detector or segmentation model that measures the eye relative to this guide. Until that model is available, the UI must not issue contradictory too-close/too-far instructions.

The supplied reference image is a positive visual example only. It does not provide negative examples or a validated anatomical model. It must not be used to claim that the five-class anatomical gate is operational.
