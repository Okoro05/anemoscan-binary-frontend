# AnemoScan five-class anatomical gate: training handoff

This folder defines the data preparation and training process for the anatomical capture model. It is separate from the existing anemia prediction model. Do not change the anemia model or its API as part of this work.

## What the model must recognise

Every image must receive exactly one reviewed label:

| Folder / label | Meaning | Capture decision |
|---|---|---|
| `closed_eye` | Eyelids closed or almost closed; lower palpebral conjunctiva is not visible | Reject |
| `open_eye_no_conjunctiva` | Eye is open, but the lower palpebral conjunctiva is not exposed | Reject |
| `partial_conjunctiva` | Some inner lower eyelid is visible, but exposure is insufficient for the capture protocol | Reject |
| `conjunctiva_visible` | Lower palpebral conjunctiva is clearly exposed and sufficiently visible | Candidate accept |
| `unusable_image` | No usable eye, wrong region, obstruction, severe blur, or image cannot be judged | Reject |

Only the final class can pass the anatomical gate. A prediction must also meet the calibrated confidence and class-margin thresholds.

## Human labelling is required first

The current 200-image ZIP is mostly close-up images with the lower lid pulled down. It is not a balanced five-class dataset. The spreadsheet generated for the ZIP contains preliminary image measurements and candidate labels, not final verified labels.

A reviewer who understands lower palpebral conjunctiva anatomy should review each image and confirm its label. A clinician or the project's clinical supervisor should resolve uncertain examples. Do not infer labels from filenames, anemia status, Hb, age, sex, or image brightness.

Record:
- filename and participant ID;
- one of the five labels above;
- reviewer and review date;
- image-quality notes;
- consent / ethics reference held in the study records.

Do not put patient names or direct identifiers in the training folders. Use participant IDs and ensure the study has permission to use the images for model development.

## Folder layout after labelling

Keep the original archive unchanged. Make a separate working copy:

```text
anemoscan-anatomical-data/
  images/
    closed_eye/
    open_eye_no_conjunctiva/
    partial_conjunctiva/
    conjunctiva_visible/
    unusable_image/
  labels.csv
  splits/
    train.csv
    validation.csv
    test.csv
```

Each image must appear in exactly one class folder. `labels.csv` should contain at least `filename,participant_id,label,reviewer`.

## Split rules

- Split by participant, not by individual image. Images from one participant must never appear in both training and test sets.
- Keep a held-out test set untouched until model selection is complete.
- Make the class counts visible before training. Do not train a five-class model if one or more classes have no reviewed examples.
- Aim for balanced classes where possible. If classes are imbalanced, use class weights or a documented sampling strategy.
- Keep images from the same capture session together to reduce leakage.

## Training and evaluation

Use transfer learning with a compact image classifier (for example, EfficientNet-B0 or MobileNetV3) and the five reviewed classes. Start with image resizing and mild, realistic augmentation. Do not use augmentations that change eye anatomy or invent conjunctiva exposure.

Report on the untouched test set:
- confusion matrix;
- per-class precision, recall and F1;
- macro F1 and balanced accuracy;
- sensitivity for `conjunctiva_visible`;
- specificity for rejecting all four invalid classes;
- calibration / confidence behaviour.

Review false accepts especially carefully. A closed eye, ordinary open eye without exposed conjunctiva, partial exposure, or unusable image must never be silently treated as a valid capture.

## Connecting to the web app

The frontend currently contains a conservative prediction contract in `web/src/lib/anatomical-gate.ts`. It does not run an image model. The live message “No visible eye detected” is currently a basic pixel-ratio heuristic and is not a validated eye detector.

After training and independent evaluation:
1. Export the selected model to ONNX.
2. Add a dedicated anatomical prediction endpoint or a browser-compatible inference module.
3. Return the five-class probabilities and model version.
4. Call `validateAnatomicalPrediction` on the prediction.
5. Require both anatomical acceptance and image-quality acceptance.
6. Require the accepted state to remain stable across several consecutive frames before a single automatic capture.
7. Re-run the held-out test and device capture checks before enabling automatic capture.

Do not enable automatic capture using the existing brightness, sharpness, contrast, skin-ratio, or sclera-ratio heuristics alone.

## External reference datasets

External datasets may help reviewers understand the difference between open and closed eyes or what conjunctiva-visible examples look like. They are not a substitute for labels matching these five exact classes. Check each dataset's licence and terms before copying images into the study dataset. Google Images results should be used only as visual references unless the source explicitly grants reuse rights.
