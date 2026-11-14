// Port de rembg (github.com/danielgatis/rembg) : modèle isnet-general-use (ISNet).
// Reprend le pipeline Python de rembg pour obtenir le même masque :
//   1. entrée redimensionnée en 1024×1024 (Lanczos), divisée par le maximum des pixels,
//      puis normalisée avec moyenne 0.5 et écart-type 1.0 ;
//   2. sortie du modèle normalisée entre son minimum et son maximum ;
//   3. masque ramené à la taille d'origine (Lanczos) et utilisé comme canal alpha.
// Aucun post-traitement n'est appliqué, comme dans `rembg.remove()` par défaut.

const ISNET_SIZE = 1024;

// sharp : module sharp ; ort : module onnxruntime-node ; session : InferenceSession déjà chargée.
// original : Buffer PNG/JPEG déjà orienté (EXIF). Retourne { mask, width, height }
// où mask est un Buffer 8 bits (un canal) à la taille de l'image d'origine.
async function predictIsnetMask(sharp, ort, session, original) {
  const meta = await sharp(original).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error('Dimensions de l’image illisibles.');

  // Étape 1 : entrée du modèle, comme PIL convert("RGB").resize((1024,1024), LANCZOS).
  const { data: rgb } = await sharp(original)
    .removeAlpha()
    .resize(ISNET_SIZE, ISNET_SIZE, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let maxValue = 0;
  for (let i = 0; i < rgb.length; i++) if (rgb[i] > maxValue) maxValue = rgb[i];
  const divisor = Math.max(maxValue, 1e-6);

  const planeSize = ISNET_SIZE * ISNET_SIZE;
  const input = new Float32Array(3 * planeSize);
  for (let i = 0; i < planeSize; i++) {
    input[i] = rgb[i * 3] / divisor - 0.5;
    input[planeSize + i] = rgb[i * 3 + 1] / divisor - 0.5;
    input[planeSize * 2 + i] = rgb[i * 3 + 2] / divisor - 0.5;
  }

  // Étape 2 : inférence puis normalisation min-max de la première sortie.
  const tensor = new ort.Tensor('float32', input, [1, 3, ISNET_SIZE, ISNET_SIZE]);
  const outputs = await session.run({ [session.inputNames[0]]: tensor });
  const pred = outputs[session.outputNames[0]].data;
  if (!pred || pred.length !== planeSize) {
    throw new Error(`Sortie ISNet inattendue : ${pred ? pred.length : 0} valeurs.`);
  }
  let mi = Infinity;
  let ma = -Infinity;
  for (let i = 0; i < planeSize; i++) {
    const v = pred[i];
    if (!Number.isFinite(v)) throw new Error('Le modèle a produit un masque invalide.');
    if (v < mi) mi = v;
    if (v > ma) ma = v;
  }
  if (ma - mi < 1e-12) throw new Error('Le masque du modèle est uniforme : détourage impossible sur cette image.');
  const small = Buffer.alloc(planeSize);
  for (let i = 0; i < planeSize; i++) {
    // Équivalent de np.astype("uint8") après (pred - mi) / (ma - mi) * 255 : troncature.
    small[i] = Math.min(255, Math.trunc(((pred[i] - mi) / (ma - mi)) * 255));
  }

  // Étape 3 : retour à la taille d'origine, comme PIL resize(img.size, LANCZOS).
  const mask = await sharp(small, { raw: { width: ISNET_SIZE, height: ISNET_SIZE, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .extractChannel(0)
    .raw()
    .toBuffer();
  return { mask, width, height };
}

module.exports = { predictIsnetMask, ISNET_SIZE };
